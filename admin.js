import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// --- 全域狀態與架構初始化 ---
let supabase = null;
let currentTab = 'settings';
let currentEventFilter = 'pending'; // 'pending' | 'approved'
let currentPolFilter = 'all';       // 政治人物過濾：'all' 或 政治人物 ID
let cachePoliticians = [];          // 全域人物快取
let cacheIssues = [];               // 全域議題快取
let currentFetchedEvents = [];      // 當前分頁抓取的原始事件資料

/**
 * 系統初始化：自動驗證金鑰
 */
window.onload = () => {
    const savedUrl = sessionStorage.getItem('polipoli_admin_url');
    const savedKey = sessionStorage.getItem('polipoli_admin_key');

    if (savedUrl && savedKey) {
        document.getElementById('db-url').value = savedUrl;
        document.getElementById('db-key').value = savedKey;
        window.attemptUnlock();
    }
};

/**
 * 系統解鎖與權限驗證
 */
window.attemptUnlock = async function() {
    const url = document.getElementById('db-url').value.trim();
    const key = document.getElementById('db-key').value.trim();

    if (!url || !key) {
        alert('請完整輸入後台連線網址與 service_role 最高權限私鑰！');
        return;
    }

    try {
        // 初始化 Supabase Client (Senior Architect: 不在前端持久化 Session 以增進安全性)
        supabase = createClient(url, key, { auth: { persistSession: false } });

        // 權限測試
        const { error } = await supabase.from('politicians').select('id').limit(1);
        if (error) throw error;

        // 驗證成功，存入 SessionStorage
        sessionStorage.setItem('polipoli_admin_url', url);
        sessionStorage.setItem('polipoli_admin_key', key);
        
        document.getElementById('unlock-screen').style.display = 'none';
        document.getElementById('admin-panel').style.display = 'block';

        await refreshAllAdminData();
    } catch (err) {
        alert('連線失敗！請確認網址正確且具有 service_role 權限。\n' + err.message);
    }
};

/**
 * 安全登出與清除狀態
 */
window.lockAndLogOut = function() {
    if (confirm('確認安全登出控制台並清除本地暫存憑證嗎？')) {
        sessionStorage.clear();
        window.location.reload();
    }
};

/**
 * 同步快取資料 (人物與議題)
 */
async function refreshAllAdminData() {
    const [polRes, issueRes] = await Promise.all([
        supabase.from('politicians').select('*').order('name'),
        supabase.from('issues').select('*').order('name')
    ]);

    if (polRes.data) cachePoliticians = polRes.data;
    if (issueRes.data) cacheIssues = issueRes.data;

    renderSettingsLists();

    if (currentTab === 'review') {
        await fetchReviewData();
    }
}

/**
 * 分頁切換控制
 */
window.switchAdminTab = function(tabName) {
    currentTab = tabName;
    
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-btn-${tabName}`).classList.add('active');

    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-content-${tabName}`).classList.add('active');

    if (tabName === 'review') {
        fetchReviewData();
    }
};

/**
 * 批次數據匯入邏輯
 */
window.importPastedJSON = async function() {
    const textarea = document.getElementById('json-paste-area');
    const rawText = textarea.value.trim();
    const btn = document.getElementById('btn-execute-import');

    if (!rawText) return alert('請先貼上 JSON 數據！');

    try {
        const eventsArray = JSON.parse(rawText);
        if (!Array.isArray(eventsArray)) return alert('匯入格式必須為陣列 [ ... ]');

        if (!confirm(`偵測到 ${eventsArray.length} 筆事件，確認開始批次寫入？`)) return;

        btn.disabled = true;
        btn.innerHTML = '⚡ 數據清洗與寫入中...';

        let successCount = 0;
        const validCategories = ["司法案件", "承諾跳票", "說法反覆", "雙重標準", "程序爭議", "行政爭議", "不當言論", "抹黑指控", "造假爭議", "資訊錯誤", "失言爭議", "利益衝突", "其他"];

        for (const item of eventsArray) {
            let issueId = null;

            // 1. 處理議題關聯 (不存在則新增)
            if (item.issue_name) {
                let issue = cacheIssues.find(i => i.name === item.issue_name.trim());
                if (!issue) {
                    const { data } = await supabase.from('issues').insert({ name: item.issue_name.trim() }).select().single();
                    if (data) {
                        cacheIssues.push(data);
                        issue = data;
                    }
                }
                if (issue) issueId = issue.id;
            }

            // 2. 數值 Clamp 處理 (1-5)
            const influence = Math.max(1, Math.min(5, parseInt(item.influence || item.severity || 3)));
            const importance = Math.max(1, Math.min(5, parseInt(item.importance || item.severity || 3)));
            const category = validCategories.includes(item.category) ? item.category : '其他';

            // 3. 寫入 Events 主表
            const { data: newEvent, error: evErr } = await supabase.from('events').insert({
                quote: item.quote || '未命名爭議事件',
                context: item.context || '',
                date: item.date || null,
                category: category,
                influence: influence,
                importance: importance,
                reasoning: item.reasoning || '無 AI 理由備註',
                source_url: item.source_url || null,
                is_visible: false
            }).select().single();

            if (evErr) {
                console.error('主事件寫入失敗:', evErr);
                continue;
            }

            // 4. 寫入關聯表
            if (newEvent) {
                if (issueId) {
                    await supabase.from('event_issue_map').insert({ event_id: newEvent.id, issue_id: issueId });
                }
                if (item.politician_name) {
                    const politician = cachePoliticians.find(p => p.name === item.politician_name.trim());
                    if (politician) {
                        await supabase.from('event_politician_map').insert({ event_id: newEvent.id, politician_id: politician.id });
                    }
                }
                successCount++;
            }
        }

        alert(`🎉 成功上架 ${successCount} 筆事件至待審核區。`);
        textarea.value = '';
        await refreshAllAdminData();
    } catch (err) {
        alert('JSON 解析或寫入失敗：' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🚀 執行強效大數據匯入';
    }
};

/**
 * 基礎管理功能 (CRUD)
 */
function renderSettingsLists() {
    document.getElementById('list-politicians').innerHTML = cachePoliticians.map(p => `
        <div class="item-row">
            <div class="item-row-left"><span class="item-title">👤 ${p.name}</span><span class="item-sub">${p.party || '未知'}</span></div>
            <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deletePolitician('${p.id}')">刪除</button>
        </div>
    `).join('');

    document.getElementById('list-issues').innerHTML = cacheIssues.map(i => `
        <div class="item-row">
            <div class="item-row-left"><span class="item-title">📌 ${i.name}</span></div>
            <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deleteIssue('${i.id}')">刪除</button>
        </div>
    `).join('');
}

window.addPolitician = async function() {
    const name = document.getElementById('new-pol-name').value.trim();
    const party = document.getElementById('new-pol-party').value.trim();
    if (name) {
        await supabase.from('politicians').insert({ name, party });
        document.getElementById('new-pol-name').value = '';
        document.getElementById('new-pol-party').value = '';
        await refreshAllAdminData();
    }
};

window.addIssue = async function() {
    const name = document.getElementById('new-issue-name').value.trim();
    if (name) {
        await supabase.from('issues').insert({ name });
        document.getElementById('new-issue-name').value = '';
        await refreshAllAdminData();
    }
};

window.deletePolitician = async function(id) {
    if (confirm('確定刪除此人物？相關事件關聯將因 Cascade 移除。')) {
        await supabase.from('politicians').delete().eq('id', id);
        await refreshAllAdminData();
    }
};

window.deleteIssue = async function(id) {
    if (confirm('確定刪除此議題？相關事件關聯將因 Cascade 移除。')) {
        await supabase.from('issues').delete().eq('id', id);
        await refreshAllAdminData();
    }
};

/**
 * 審核牆核心：資料抓取與渲染分離
 */
window.setEventFilter = function(filterType) {
    currentEventFilter = filterType;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`filter-btn-${filterType}`).classList.add('active');
    fetchReviewData();
};

window.setPolFilter = function(polId) {
    currentPolFilter = polId;
    renderReviewFeed(); // 切換過濾器不觸發網絡請求
};

async function fetchReviewData() {
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
    renderReviewFeed();
}

function renderReviewFeed() {
    const container = document.getElementById('review-list-container');
    
    // 前端過濾邏輯
    let filteredEvents = currentFetchedEvents;
    if (currentPolFilter !== 'all') {
        filteredEvents = currentFetchedEvents.filter(ev => 
            ev.event_politician_map?.some(m => m.politician_id === currentPolFilter)
        );
    }

    // 生成過濾下拉選單
    const polFilterHTML = `
        <div style="margin-bottom: 1.5rem; background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; align-items: center; gap: 10px;">
            <label for="review-pol-filter" style="font-weight: bold; font-size: 0.9rem;">👤 人物快速過濾：</label>
            <select id="review-pol-filter" class="form-input" style="width: auto; margin-bottom: 0;" onchange="setPolFilter(this.value)">
                <option value="all" ${currentPolFilter === 'all' ? 'selected' : ''}>-- 顯示所有政治人物 --</option>
                ${cachePoliticians.map(p => `
                    <option value="${p.id}" ${currentPolFilter === p.id ? 'selected' : ''}>${p.name} (${p.party || '未知'})</option>
                `).join('')}
            </select>
            <span style="font-size: 0.85rem; color: #64748b; margin-left: auto;">目前符合條件：${filteredEvents.length} 筆</span>
        </div>
    `;

    if (filteredEvents.length === 0) {
        container.innerHTML = polFilterHTML + `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-weight:bold;">🎉 目前此區塊內乾乾淨淨。</div>`;
        return;
    }

    const cardsHTML = filteredEvents.map(ev => {
        const inf = ev.influence || 3;
        const imp = ev.importance || 3;
        const polNames = ev.event_politician_map?.map(m => m.politicians?.name).filter(Boolean).join(', ') || '未掛名人物';
        const issueNames = ev.event_issue_map?.map(m => m.issues?.name).filter(Boolean).join(', ') || '未設定議題';
        
        return `
            <div class="review-card">
                <div class="review-card-meta">
                    <span class="review-badge">📅 ${ev.date || '日期未明'}</span>
                    <span class="review-badge">📂 ${ev.category || '未分類'}</span>
                    <span class="review-badge">👤 ${polNames}</span>
                    <span class="review-badge">📌 ${issueNames}</span>
                    <span class="review-badge ${inf >= 4 ? 'hot' : ''}">🔥 熱度: ${inf}</span>
                    <span class="review-badge ${imp >= 4 ? 'severe' : ''}">⚠️ 嚴重性: ${imp}</span>
                </div>
                <h3 style="margin: 10px 0; font-size:1.2rem;">「${ev.quote}」</h3>
                <p style="color: #475569; font-size:0.95rem; margin-bottom:1rem;">${ev.context || '無描述脈絡。'}</p>
                <div style="font-size: 0.9rem; margin-bottom: 1rem;">
                    ${ev.source_url ? `<a href="${ev.source_url}" target="_blank" style="color: #3b82f6; text-decoration: underline;">🔗 新聞來源：[點擊前往]</a>` : `<span style="color: #94a3b8;">🔗 無來源連結</span>`}
                </div>
                ${ev.reasoning ? `<div class="review-reasoning">💡 AI 理由：${ev.reasoning}</div>` : ''}
                <div class="review-actions">
                    <button class="btn btn-secondary" onclick="openEditModal('${ev.id}')">✏️ 編輯校正</button>
                    <button class="btn ${ev.is_visible ? 'btn-secondary' : 'btn-success'}" onclick="toggleEventVisibility('${ev.id}', ${ev.is_visible})">
                        ${ev.is_visible ? '🔴 下架隱藏' : '🟢 開放顯示'}
                    </button>
                    <button class="btn btn-danger" onclick="deleteEventAbsolute('${ev.id}')">🗑️ 徹底刪除</button>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = polFilterHTML + cardsHTML;
}

/**
 * 編輯 Modal 控制
 */
window.openEditModal = async function(eventId) {
    const ev = currentFetchedEvents.find(e => e.id === eventId);
    if (!ev) return;

    document.getElementById('edit-event-id').value = ev.id;
    document.getElementById('edit-quote').value = ev.quote;
    document.getElementById('edit-date').value = ev.date || '';
    document.getElementById('edit-category').value = ev.category || '其他';
    document.getElementById('edit-influence').value = ev.influence || 3;
    document.getElementById('edit-importance').value = ev.importance || 3;
    document.getElementById('edit-context').value = ev.context || '';
    document.getElementById('edit-source-url').value = ev.source_url || '';

    // 人物多選
    const activePolIds = ev.event_politician_map?.map(m => m.politician_id) || [];
    document.getElementById('edit-politicians-checkboxes').innerHTML = cachePoliticians.map(p => `
        <label class="checkbox-label">
            <input type="checkbox" name="edit-pol-box" value="${p.id}" ${activePolIds.includes(p.id) ? 'checked' : ''}>
            ${p.name}
        </label>
    `).join('');

    // 核心修復：議題單選語法精準化
    const currentIssueId = ev.event_issue_map?.[0]?.issue_id || '';
    let issueOptions = '<option value="">-- 未選定 / 無特定議題 --</option>';
    cacheIssues.forEach(i => {
        issueOptions += `<option value="${i.id}" ${i.id === currentIssueId ? 'selected' : ''}>📌 ${i.name}</option>`;
    });
    document.getElementById('edit-issue-select').innerHTML = issueOptions;

    document.getElementById('edit-modal').classList.add('active');
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').classList.remove('active');
};

/**
 * 儲存編輯內容 (先更新主表，再重刷關聯)
 */
window.saveEventEdits = async function() {
    const id = document.getElementById('edit-event-id').value;
    const quote = document.getElementById('edit-quote').value.trim();
    const date = document.getElementById('edit-date').value || null; // 處理日期空值
    const category = document.getElementById('edit-category').value;
    const influence = parseInt(document.getElementById('edit-influence').value);
    const importance = parseInt(document.getElementById('edit-importance').value);
    const context = document.getElementById('edit-context').value.trim();
    const source_url = document.getElementById('edit-source-url').value.trim() || null;

    // 1. 更新主表
    const { error: mainErr } = await supabase.from('events').update({
        quote, date, category, influence, importance, context, source_url
    }).eq('id', id);

    if (mainErr) return alert('儲存失敗: ' + mainErr.message);

    // 2. 重置政治人物關聯
    await supabase.from('event_politician_map').delete().eq('event_id', id);
    const polInserts = Array.from(document.querySelectorAll('input[name="edit-pol-box"]:checked')).map(box => ({
        event_id: id,
        politician_id: box.value
    }));
    if (polInserts.length > 0) await supabase.from('event_politician_map').insert(polInserts);

    // 3. 重置議題關聯
    await supabase.from('event_issue_map').delete().eq('event_id', id);
    const chosenIssueId = document.getElementById('edit-issue-select').value;
    if (chosenIssueId) await supabase.from('event_issue_map').insert({ event_id: id, issue_id: chosenIssueId });

    alert('💾 變更已同步至資料庫。');
    closeEditModal();
    await fetchReviewData();
};

/**
 * 狀態切換與批次操作
 */
window.toggleEventVisibility = async function(id, currentStatus) {
    const { error } = await supabase.from('events').update({ is_visible: !currentStatus }).eq('id', id);
    if (error) {
        alert('操作失敗:' + error.message);
    } else {
        console.log(`Event ${id} visibility toggled to ${!currentStatus}`);
        await fetchReviewData();
    }
};

window.publishAllPending = async function() {
    if (currentEventFilter !== 'pending') return alert('請切換至「待審核」分頁進行批次操作。');

    const pendingIds = currentFetchedEvents.filter(ev => !ev.is_visible).map(ev => ev.id);
    if (pendingIds.length === 0) return alert('無可上架的事件。');

    if (!confirm(`確定要公開當前列表中的 ${pendingIds.length} 筆事件？`)) return;

    const batchSize = 50;
    for (let i = 0; i < pendingIds.length; i += batchSize) {
        const chunk = pendingIds.slice(i, i + batchSize);
        await supabase.from('events').update({ is_visible: true }).in('id', chunk);
    }

    alert('✅ 批次上架完成。');
    await fetchReviewData();
};

window.deleteEventAbsolute = async function(id) {
    if (confirm('確定要永久刪除此事件？此操作無法還原。')) {
        await supabase.from('events').delete().eq('id', id);
        await fetchReviewData();
    }
};
