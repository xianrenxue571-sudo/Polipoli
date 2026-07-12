import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;
let currentTab = 'settings';
let currentEventFilter = 'pending';

// 系統快取資料
let cachePoliticians = [];
let cacheIssues = [];
let currentFetchedEvents = [];

// ==========================================
// 1. 初始化與安全登入邏輯
// ==========================================
window.onload = () => {
    const savedUrl = sessionStorage.getItem('polipoli_admin_url');
    const savedKey = sessionStorage.getItem('polipoli_admin_key');
    if (savedUrl && savedKey) {
        document.getElementById('db-url').value = savedUrl;
        document.getElementById('db-key').value = savedKey;
        attemptUnlock();
    }
};

window.attemptUnlock = async function() {
    const url = document.getElementById('db-url').value.trim();
    const key = document.getElementById('db-key').value.trim();

    if (!url || !key) {
        alert('請完整輸入後台連線網址與 service_role 最高權限私鑰！');
        return;
    }

    try {
        supabase = createClient(url, key, { auth: { persistSession: false } });
        // 測試連線
        const { error } = await supabase.from('politicians').select('id').limit(1);
        if (error) throw error;

        sessionStorage.setItem('polipoli_admin_url', url);
        sessionStorage.setItem('polipoli_admin_key', key);
        
        document.getElementById('unlock-screen').style.display = 'none';
        document.getElementById('admin-panel').style.display = 'block';
        
        await refreshAllAdminData();
    } catch (err) {
        alert('連線或驗證失敗，請檢查憑證與網址是否包含空白：' + err.message);
    }
};

window.lockAndLogOut = function() {
    sessionStorage.removeItem('polipoli_admin_url');
    sessionStorage.removeItem('polipoli_admin_key');
    location.reload();
};

// ==========================================
// 2. 頁籤切換與資料重整
// ==========================================
window.switchTab = function(tabId) {
    currentTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    document.getElementById(`tab-btn-${tabId}`).classList.add('active');
    document.getElementById(`tab-${tabId}`).classList.add('active');

    if (tabId === 'review') {
        fetchAndRenderReviewFeed();
    }
};

async function refreshAllAdminData() {
    const [polRes, issueRes] = await Promise.all([
        supabase.from('politicians').select('*').order('name'),
        supabase.from('issues').select('*').order('name')
    ]);
    
    if (polRes.data) cachePoliticians = polRes.data;
    if (issueRes.data) cacheIssues = issueRes.data;

    renderSettingsLists();
    updatePoliticianFilterDropdown(); // 更新審核牆的下拉選單

    if (currentTab === 'review') {
        await fetchAndRenderReviewFeed();
    }
}

// ==========================================
// 3. 基本設定模組 (人物與議題)
// ==========================================
function renderSettingsLists() {
    const polList = document.getElementById('politician-list');
    if(polList) {
        polList.innerHTML = cachePoliticians.map(p => `
            <div class="item-row">
                <div class="item-row-left">
                    <span class="item-title">${p.name} (${p.party})</span>
                    <span class="item-sub">狀態: ${p.is_visible ? '🟢 顯示中' : '🔴 已隱藏'}</span>
                </div>
                <div>
                    <button class="btn btn-secondary" onclick="togglePoliticianVisibility('${p.id}', ${p.is_visible})">${p.is_visible ? '隱藏' : '顯示'}</button>
                    <button class="btn btn-danger" onclick="deletePolitician('${p.id}')">刪除</button>
                </div>
            </div>
        `).join('');
    }

    const issueList = document.getElementById('issue-list');
    if(issueList) {
        issueList.innerHTML = cacheIssues.map(i => `
            <div class="item-row">
                <div class="item-row-left">
                    <span class="item-title">${i.name}</span>
                </div>
                <div>
                    <button class="btn btn-danger" onclick="deleteIssue('${i.id}')">刪除</button>
                </div>
            </div>
        `).join('');
    }
}

window.addPolitician = async function() {
    const name = document.getElementById('new-pol-name').value.trim();
    const party = document.getElementById('new-pol-party').value.trim();
    if(!name || !party) return alert('請填寫完整資訊');
    
    const {error} = await supabase.from('politicians').insert({name, party});
    if(error) alert('新增失敗: ' + error.message);
    else {
        document.getElementById('new-pol-name').value = '';
        document.getElementById('new-pol-party').value = '';
        refreshAllAdminData();
    }
};

window.togglePoliticianVisibility = async function(id, currentStatus) {
    await supabase.from('politicians').update({is_visible: !currentStatus}).eq('id', id);
    refreshAllAdminData();
};

window.deletePolitician = async function(id) {
    if(!confirm('確定刪除人物？相關事件的「人物關聯標籤」也會一併清除（但事件本體不會被刪除）。')) return;
    await supabase.from('politicians').delete().eq('id', id);
    refreshAllAdminData();
};

window.addIssue = async function() {
    const name = document.getElementById('new-issue-name').value.trim();
    if(!name) return alert('請填寫議題名稱');
    
    const {error} = await supabase.from('issues').insert({name});
    if(error) alert('新增失敗: ' + error.message);
    else {
        document.getElementById('new-issue-name').value = '';
        refreshAllAdminData();
    }
};

window.deleteIssue = async function(id) {
    if(!confirm('確定徹底刪除此社會議題？')) return;
    await supabase.from('issues').delete().eq('id', id);
    refreshAllAdminData();
};

// ==========================================
// 4. JSON 文本匯入模組
// ==========================================
window.importJSON = async function() {
    const btn = document.getElementById('import-btn');
    const originalText = btn.innerText;
    const jsonText = document.getElementById('json-input-area').value.trim();

    if (!jsonText) return alert('請在文字框中貼上 JSON 格式的內容！');

    btn.innerText = '處理與寫入中...';
    btn.disabled = true;

    try {
        const events = JSON.parse(jsonText);
        let successCount = 0;
        let failCount = 0;

        for (const ev of events) {
            // 1. 處理政治人物匹配
            let polId = cachePoliticians.find(p => p.name === ev.politician_name)?.id;
            if (!polId) {
                const {data, error} = await supabase.from('politicians').insert({
                    name: ev.politician_name,
                    party: ev.party || '未知'
                }).select().single();
                if (error) { failCount++; continue; }
                polId = data.id;
                cachePoliticians.push(data); // 更新記憶體
            }

            // 2. 處理議題匹配
            let issueId = null;
            if (ev.issue_name && ev.issue_name !== '其他') {
                let iObj = cacheIssues.find(i => i.name === ev.issue_name);
                if (!iObj) {
                    const {data, error} = await supabase.from('issues').insert({
                        name: ev.issue_name
                    }).select().single();
                    if (!error) {
                        issueId = data.id;
                        cacheIssues.push(data);
                    }
                } else {
                    issueId = iObj.id;
                }
            }

            // 3. 寫入事件主體 (圖片網址已徹底移除)
            const {data: evData, error: evError} = await supabase.from('events').insert({
                quote: ev.quote,
                date: ev.date || null,
                category: ev.category || '未分類',
                influence: ev.influence || 3,
                importance: ev.importance || 3,
                reasoning: ev.reasoning || '',
                context: ev.context || '',
                source_url: ev.source_url || null,
                is_visible: false // 匯入預設待審核
            }).select().single();

            if (evError) { 
                console.error("寫入事件失敗:", evError);
                failCount++; 
                continue; 
            }

            // 4. 寫入多對多關聯表
            await supabase.from('event_politician_map').insert({
                event_id: evData.id,
                politician_id: polId
            });

            if (issueId) {
                await supabase.from('event_issue_map').insert({
                    event_id: evData.id,
                    issue_id: issueId
                });
            }
            successCount++;
        }
        
        alert(`匯入完成！成功: ${successCount} 筆, 失敗: ${failCount} 筆`);
        document.getElementById('json-input-area').value = ''; // 清空文字框
        refreshAllAdminData();
    } catch (err) {
        alert('解析或匯入失敗，請確認內容是否為標準 JSON 格式：' + err.message);
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
};

// ==========================================
// 5. 事件審核牆模組 (獲取、過濾與渲染)
// ==========================================
window.setEventFilter = function(filter) {
    currentEventFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`filter-btn-${filter}`).classList.add('active');
    fetchAndRenderReviewFeed();
};

function updatePoliticianFilterDropdown() {
    const select = document.getElementById('filter-politician');
    if (!select) return;
    
    const currentVal = select.value;
    let html = '<option value="all">👥 全部人物</option>';
    
    cachePoliticians.forEach(p => {
        html += `<option value="${p.id}">${p.name}</option>`;
    });
    
    select.innerHTML = html;
    if (cachePoliticians.some(p => p.id === currentVal)) {
        select.value = currentVal;
    }
}

async function fetchAndRenderReviewFeed() {
    const container = document.getElementById('review-list-container');
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 2rem;">資料在庫安全檢索中...</div>';

    const isVisibleValue = currentEventFilter === 'approved';
    const { data, error } = await supabase
        .from('events')
        .select(`
            *,
            event_politician_map ( politician_id, politicians ( name ) ),
            event_issue_map ( issue_id, issues ( name ) )
        `)
        .eq('is_visible', isVisibleValue)
        .order('date', { ascending: false });
        
    if (error) {
        container.innerHTML = `<div style="color:var(--danger); font-weight:bold;">資料加載失敗：${error.message}</div>`;
        return;
    }

    currentFetchedEvents = data || [];
    window.renderReviewFeed();
}

window.renderReviewFeed = function() {
    const container = document.getElementById('review-list-container');
    const selectEl = document.getElementById('filter-politician');
    const selectedPolId = selectEl ? selectEl.value : 'all';

    // 根據下拉選單進行前端過濾
    let filteredEvents = currentFetchedEvents;
    if (selectedPolId !== 'all') {
        filteredEvents = currentFetchedEvents.filter(e => {
            if (!e.event_politician_map) return false;
            return e.event_politician_map.some(m => m.politician_id === selectedPolId);
        });
    }

    if (filteredEvents.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-weight:bold;">🎉 恭喜！目前此區塊內乾乾淨淨或查無該人物資料。</div>`;
        return;
    }

    container.innerHTML = filteredEvents.map(e => {
        const inf = e.influence || 3;
        const imp = e.importance || 3;
        const hotClass = inf >= 4 ? 'hot' : '';
        const severeClass = imp >= 4 ? 'severe' : '';

        const polNames = e.event_politician_map?.map(m => m.politicians?.name).filter(Boolean).join(', ') || '未掛名人物';
        const issueNames = e.event_issue_map?.map(m => m.issues?.name).filter(Boolean).join(', ') || '未設定議題';

        const reasoningBlock = e.reasoning ? `<div class="review-reasoning">💡 AI 理由：${e.reasoning}</div>` : '';
        const sourceLinkBlock = e.source_url 
            ? `<div style="font-size: 0.9rem; margin-bottom: 1rem;"><a href="${e.source_url}" target="_blank" rel="noopener noreferrer" style="color: #3b82f6; text-decoration: underline;">🔗 新聞來源：[點擊前往佐證連結]</a></div>`
            : `<div style="font-size: 0.9rem; color: #94a3b8; margin-bottom: 1rem;">🔗 新聞來源：[無提供連結]</div>`;

        const toggleBtnText = e.is_visible ? '🔴 下架隱藏' : '🟢 開放顯示';
        const toggleBtnStyle = e.is_visible ? 'btn-secondary' : 'btn-success';

        return `
            <div class="review-card">
                <div class="review-card-meta">
                    <span class="review-badge">📅 ${e.date || '日期未明'}</span>
                    <span class="review-badge">📂 ${e.category || '未分類'}</span>
                    <span class="review-badge">👤 ${polNames}</span>
                    <span class="review-badge">📌 ${issueNames}</span>
                    <span class="review-badge ${hotClass}">🔥 熱度: ${inf}</span>
                    <span class="review-badge ${severeClass}">⚠️ 嚴重性: ${imp}</span>
                </div>
                <h3 style="margin: 10px 0; font-size:1.2rem;">「${e.quote}」</h3>
                <p style="color: #475569; font-size:0.95rem; margin-bottom:1rem;">${e.context || '無描述脈絡。'}</p>
                ${sourceLinkBlock}
                ${reasoningBlock}
                <div class="review-actions">
                    <button class="btn btn-secondary" style="padding:6px 12px; font-size:0.85rem;" onclick="openEditModal('${e.id}')">✏️ 編輯校正</button>
                    <button class="btn ${toggleBtnStyle}" style="padding:6px 12px; font-size:0.85rem;" onclick="toggleEventVisibility('${e.id}', ${e.is_visible})">${toggleBtnText}</button>
                    <button class="btn btn-danger" style="padding:6px 12px; font-size:0.85rem;" onclick="deleteEventAbsolute('${e.id}')">🗑️ 徹底刪除</button>
                </div>
            </div>
        `;
    }).join('');
};

window.toggleEventVisibility = async function(id, currentStatus) {
    await supabase.from('events').update({is_visible: !currentStatus}).eq('id', id);
    fetchAndRenderReviewFeed(); // 重抓資料讓卡片從目前狀態牆移走
};

window.deleteEventAbsolute = async function(id) {
    if(!confirm('警告：這將徹底從資料庫中刪除該事件與其所有關聯，無法復原。確定要刪除嗎？')) return;
    await supabase.from('events').delete().eq('id', id);
    fetchAndRenderReviewFeed();
};

window.publishAllPending = async function() {
    if(!confirm('確定要將目前列表中所有「待審核」的事件一鍵公開嗎？')) return;
    
    // 依據下拉選單判斷是否只要上架特定人物
    const selectEl = document.getElementById('filter-politician');
    const selectedPolId = selectEl ? selectEl.value : 'all';

    let idsToUpdate = currentFetchedEvents.map(e => e.id);
    if (selectedPolId !== 'all') {
         idsToUpdate = currentFetchedEvents
            .filter(e => e.event_politician_map?.some(m => m.politician_id === selectedPolId))
            .map(e => e.id);
    }

    if (idsToUpdate.length === 0) return alert('沒有符合條件的可上架事件。');

    const {error} = await supabase.from('events').update({is_visible: true}).in('id', idsToUpdate);
    if(error) {
        alert('一鍵上架失敗: ' + error.message);
    } else {
        alert(`成功上架 ${idsToUpdate.length} 筆事件！`);
        fetchAndRenderReviewFeed();
    }
};

// ==========================================
// 6. 編輯 Modal 模組 (多對多關聯校正)
// ==========================================
window.openEditModal = async function(id) {
    const ev = currentFetchedEvents.find(e => e.id === id);
    if (!ev) return;

    // 填充主體欄位
    document.getElementById('edit-id').value = id;
    document.getElementById('edit-quote').value = ev.quote || '';
    document.getElementById('edit-date').value = ev.date || '';
    document.getElementById('edit-category').value = ev.category || '';
    document.getElementById('edit-influence').value = ev.influence || 3;
    document.getElementById('edit-importance').value = ev.importance || 3;
    document.getElementById('edit-context').value = ev.context || '';
    document.getElementById('edit-source-url').value = ev.source_url || '';

    // 動態生成人物複選框 (支援多選)
    const polBoxContainer = document.getElementById('edit-politicians-checkboxes');
    const currentPolIds = ev.event_politician_map?.map(m => m.politician_id) || [];
    polBoxContainer.innerHTML = cachePoliticians.map(p => `
        <label style="display:inline-flex; align-items:center; margin-right:15px; margin-bottom:10px;">
            <input type="checkbox" name="edit-pol-box" value="${p.id}" ${currentPolIds.includes(p.id) ? 'checked' : ''}>
            <span style="margin-left:5px;">${p.name}</span>
        </label>
    `).join('');

    // 動態生成議題下拉選單 (單選)
    const issueSelect = document.getElementById('edit-issue-select');
    const currentIssueId = ev.event_issue_map?.[0]?.issue_id || '';
    issueSelect.innerHTML = '<option value="">(無關聯議題)</option>' + cacheIssues.map(i => `
        <option value="${i.id}" ${i.id === currentIssueId ? 'selected' : ''}>${i.name}</option>
    `).join('');

    document.getElementById('edit-modal').classList.add('active');
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').classList.remove('active');
};

window.saveEditEvent = async function() {
    const id = document.getElementById('edit-id').value;
    const quote = document.getElementById('edit-quote').value.trim();
    const date = document.getElementById('edit-date').value || null;
    const category = document.getElementById('edit-category').value;
    const influence = parseInt(document.getElementById('edit-influence').value);
    const importance = parseInt(document.getElementById('edit-importance').value);
    const context = document.getElementById('edit-context').value.trim();
    const source_url = document.getElementById('edit-source-url').value.trim() || null;

    // 1. 更新主體表
    const { error: mainErr } = await supabase.from('events').update({
        quote, date, category, influence, importance, context, source_url
    }).eq('id', id);

    if (mainErr) {
        alert('儲存主體資料失敗: ' + mainErr.message);
        return;
    }

    // 2. 更新人物關聯表 (先刪除舊有，再寫入新勾選的)
    await supabase.from('event_politician_map').delete().eq('event_id', id);
    const selectedPolBoxes = document.querySelectorAll('input[name="edit-pol-box"]:checked');
    const polInserts = Array.from(selectedPolBoxes).map(box => ({
        event_id: id,
        politician_id: box.value
    }));
    if (polInserts.length > 0) {
        await supabase.from('event_politician_map').insert(polInserts);
    }

    // 3. 更新議題關聯表
    await supabase.from('event_issue_map').delete().eq('event_id', id);
    const chosenIssueId = document.getElementById('edit-issue-select').value;
    if (chosenIssueId) {
        await supabase.from('event_issue_map').insert({ event_id: id, issue_id: chosenIssueId });
    }

    closeEditModal();
    fetchAndRenderReviewFeed(); // 儲存後重整畫面
};
