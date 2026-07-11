import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;
let currentTab = 'settings';
let currentEventFilter = 'pending';

let cachePoliticians = [];
let cacheIssues = [];
let currentFetchedEvents = [];

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
        const { error } = await supabase.from('politicians').select('id').limit(1);
        if (error) throw error;

        sessionStorage.setItem('polipoli_admin_url', url);
        sessionStorage.setItem('polipoli_admin_key', key);
        
        document.getElementById('unlock-screen').style.display = 'none';
        document.getElementById('admin-panel').style.display = 'block';
        
        await refreshAllAdminData();
    } catch (err) {
        alert('連線失敗！請確認 Supabase 網址正確且貼上的是最高權限私鑰。\n' + err.message);
    }
};

window.lockAndLogOut = function() {
    if(confirm('確認安全登出控制台並清除本地暫存憑證嗎？')) {
        sessionStorage.clear();
        window.location.reload();
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
    if (currentTab === 'review') {
        await fetchAndRenderReviewFeed();
    }
}

window.switchAdminTab = function(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-btn-${tabName}`).classList.add('active');
    
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-content-${tabName}`).classList.add('active');

    if (tabName === 'review') {
        fetchAndRenderReviewFeed();
    }
};

window.importPastedJSON = async function() {
    const textarea = document.getElementById('json-paste-area');
    const rawText = textarea.value.trim();
    const btn = document.getElementById('btn-execute-import');

    if (!rawText) {
        alert('請先貼上 JSON 格式的數據文字！');
        return;
    }

    try {
        const eventsArray = JSON.parse(rawText);
        if (!Array.isArray(eventsArray)) {
            alert('匯入格式有誤：外層必須是方括號包覆的陣列 [ ... ]！');
            return;
        }

        if (!confirm(`偵測到 ${eventsArray.length} 筆事件，確認開始批次寫入資料庫嗎？`)) return;
        btn.disabled = true;
        btn.innerHTML = '⚡ 數據清洗與寫入中...請勿關閉視窗';

        let successCount = 0;
        for (const item of eventsArray) {
            let issueId = null;
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

            const { data: newEvent, error: evErr } = await supabase.from('events').insert({
                quote: item.quote || '未命名爭議事件',
                context: item.context || '',
                date: item.date || null,
                category: item.category || '其他',
                influence: item.influence ? parseInt(item.influence) : (item.severity ? parseInt(item.severity) : 3),
                importance: item.importance ? parseInt(item.importance) : (item.severity ? parseInt(item.severity) : 3),
                reasoning: item.reasoning || '無 AI 理由備註',
                source_url: item.source_url || null,
                is_visible: false 
            }).select().single();

            if (evErr) {
                console.error('主事件寫入失敗:', evErr);
                continue;
            }

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

        alert(`🎉 批次操作大成功！一共成功上架 ${successCount} 筆事件至待審核區。`);
        textarea.value = '';
        await refreshAllAdminData();
    } catch (err) {
        alert('JSON 解析失敗！請確認複製的代碼結構完整無破損。\n詳情描述：' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🚀 執行強效大數據匯入';
    }
};

function renderSettingsLists() {
    const polList = document.getElementById('list-politicians');
    polList.innerHTML = cachePoliticians.map(p => `
        <div class="item-row">
            <div class="item-row-left">
                <span class="item-title">👤 ${p.name}</span>
                <span class="item-sub">${p.party || '未知政黨'}</span>
            </div>
            <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deletePolitician('${p.id}')">刪除</button>
        </div>
    `).join('');
    const issueList = document.getElementById('list-issues');
    issueList.innerHTML = cacheIssues.map(i => `
        <div class="item-row">
            <div class="item-row-left">
                <span class="item-title">📌 ${i.name}</span>
            </div>
            <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deleteIssue('${i.id}')">刪除</button>
        </div>
    `).join('');
}

window.addPolitician = async function() {
    const name = document.getElementById('new-pol-name').value.trim();
    const party = document.getElementById('new-pol-party').value.trim();
    if (!name) return;
    await supabase.from('politicians').insert({ name, party });
    document.getElementById('new-pol-name').value = '';
    document.getElementById('new-pol-party').value = '';
    await refreshAllAdminData();
};

window.addIssue = async function() {
    const name = document.getElementById('new-issue-name').value.trim();
    if (!name) return;
    await supabase.from('issues').insert({ name });
    document.getElementById('new-issue-name').value = '';
    await refreshAllAdminData();
};

window.deletePolitician = async function(id) {
    if (confirm('確定刪除此人物嗎？')) {
        await supabase.from('politicians').delete().eq('id', id);
        await refreshAllAdminData();
    }
};

window.deleteIssue = async function(id) {
    if (confirm('確定刪除此議題嗎？')) {
        await supabase.from('issues').delete().eq('id', id);
        await refreshAllAdminData();
    }
};

window.setEventFilter = function(filterType) {
    currentEventFilter = filterType;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`filter-btn-${filterType}`).classList.add('active');
    fetchAndRenderReviewFeed();
};

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
    if (currentFetchedEvents.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted); font-weight:bold;">🎉 恭喜！目前此區塊內乾乾淨淨。</div>`;
        return;
    }

    container.innerHTML = currentFetchedEvents.map(e => {
        const inf = e.influence || e.severity || 3;
        const imp = e.importance || e.severity || 3;
        const hotClass = inf >= 4 ? 'hot' : '';
        const severeClass = imp >= 4 ? 'severe' : '';

        const polNames = e.event_politician_map?.map(m => m.politicians?.name).filter(Boolean).join(', ') || '未掛名人物';
        const issueNames = e.event_issue_map?.map(m => m.issues?.name).filter(Boolean).join(', ') || '未設定議題';

        const reasoningBlock = e.reasoning ? `<div class="review-reasoning">💡 AI 理由：${e.reasoning}</div>` : '';

        const toggleBtnText = e.is_visible ? '🔴 下架隱藏' : '🟢 開放顯示';
        const toggleBtnStyle = e.is_visible ? 'btn-secondary' : 'btn-success';

        return `
            <div class="review-card">
                <div class="review-card-meta">
                    <span class="review-badge">📅 ${e.date || '日期未明'}</span>
                    <span class="review-badge">📂 分類: ${e.category || '未分類'}</span>
                    <span class="review-badge">👤 人物: ${polNames}</span>
                    <span class="review-badge">📌 議題: ${issueNames}</span>
                    <span class="review-badge ${hotClass}">🔥 熱度: ${inf}</span>
                    <span class="review-badge ${severeClass}">⚠️ 嚴重性: ${imp}</span>
                </div>
                <h3 style="margin: 10px 0; font-size:1.2rem;">「${e.quote}」</h3>
                <p style="color: #475569; font-size:0.95rem; margin-bottom:1rem;">${e.context || '無描述脈絡。'}</p>
                ${reasoningBlock}
                <div class="review-actions">
                    <button class="btn btn-secondary" style="padding:6px 12px; font-size:0.85rem;" onclick="openEditModal('${e.id}')">✏️ 編輯校正</button>
                    <button class="btn ${toggleBtnStyle}" style="padding:6px 12px; font-size:0.85rem;" onclick="toggleEventVisibility('${e.id}', ${e.is_visible})">${toggleBtnText}</button>
                    <button class="btn btn-danger" style="padding:6px 12px; font-size:0.85rem;" onclick="deleteEventAbsolute('${e.id}')">🗑️ 徹底刪除</button>
                </div>
            </div>
        `;
    }).join('');
}

window.toggleEventVisibility = async function(id, currentStatus) {
    const { error } = await supabase.from('events').update({ is_visible: !currentStatus }).eq('id', id);
    if (error) alert('操作失敗:' + error.message);
    await fetchAndRenderReviewFeed();
};

window.deleteEventAbsolute = async function(id) {
    if (confirm('確定要永久刪除這筆事件嗎？')) {
        await supabase.from('events').delete().eq('id', id);
        await fetchAndRenderReviewFeed();
    }
};
window.openEditModal = async function(eventId) {
    const ev = currentFetchedEvents.find(e => e.id === eventId);
    if (!ev) return;

    document.getElementById('edit-event-id').value = ev.id;
    document.getElementById('edit-quote').value = ev.quote;
    document.getElementById('edit-date').value = ev.date || '';
    document.getElementById('edit-category').value = ev.category || '其他';
    document.getElementById('edit-influence').value = ev.influence || ev.severity || 3;
    document.getElementById('edit-importance').value = ev.importance || ev.severity || 3;
    document.getElementById('edit-context').value = ev.context || '';
    document.getElementById('edit-source-url').value = ev.source_url || '';
    
    const activePolIds = ev.event_politician_map?.map(m => m.politician_id) || [];
    const checkboxContainer = document.getElementById('edit-politicians-checkboxes');
    checkboxContainer.innerHTML = cachePoliticians.map(p => {
        const checked = activePolIds.includes(p.id) ? 'checked' : '';
        return `
            <label class="checkbox-label">
                <input type="checkbox" name="edit-pol-box" value="${p.id}" ${checked}>
                ${p.name}
            </label>
        `;
    }).join('');
    const currentIssueId = ev.event_issue_map?.[0]?.issue_id || '';
    const issueSelect = document.getElementById('edit-issue-select');
    let issueOptions = '<option value="">-- 未選定 / 無特定議題 --</option>';
    cacheIssues.forEach(i => {
        const selected = i.id === currentIssueId ? 'selected' : '';
        issueOptions += `<option value="${i.id}" ${selected}>📌 ${i.name}</option>`;
    });
    issueSelect.innerHTML = issueOptions;

    document.getElementById('edit-modal').classList.add('active');
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').classList.remove('active');
};

window.saveEventEdits = async function() {
    const id = document.getElementById('edit-event-id').value;
    const quote = document.getElementById('edit-quote').value.trim();
    const date = document.getElementById('edit-date').value || null;
    const category = document.getElementById('edit-category').value;
    const influence = parseInt(document.getElementById('edit-influence').value);
    const importance = parseInt(document.getElementById('edit-importance').value);
    const context = document.getElementById('edit-context').value.trim();
    const source_url = document.getElementById('edit-source-url').value.trim() || null;
    const { error: mainErr } = await supabase.from('events').update({
        quote, date, category, influence, importance, context, source_url
    }).eq('id', id);
    if (mainErr) {
        alert('儲存主體資料失敗: ' + mainErr.message);
        return;
    }

    await supabase.from('event_politician_map').delete().eq('event_id', id);
    const selectedPolBoxes = document.querySelectorAll('input[name="edit-pol-box"]:checked');
    const polInserts = Array.from(selectedPolBoxes).map(box => ({
        event_id: id,
        politician_id: box.value
    }));
    if (polInserts.length > 0) {
        await supabase.from('event_politician_map').insert(polInserts);
    }

    await supabase.from('event_issue_map').delete().eq('event_id', id);
    const chosenIssueId = document.getElementById('edit-issue-select').value;
    if (chosenIssueId) {
        await supabase.from('event_issue_map').insert({ event_id: id, issue_id: chosenIssueId });
    }

    alert('💾 事件核心資料與對比關聯儲存成功！');
    closeEditModal();
    await fetchAndRenderReviewFeed();
};
