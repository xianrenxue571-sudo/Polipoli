import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;
let currentTab = 'settings';
let currentEventFilter = 'pending';
let currentPolFilter = 'all';
let cachePoliticians = [];
let cacheIssues = [];
let currentFetchedEvents = [];

window.onload = () => {
    const savedUrl = sessionStorage.getItem('polipoli_admin_url');
    const savedKey = sessionStorage.getItem('polipoli_admin_key');
    if (savedUrl && savedKey) {
        const urlInput = document.getElementById('db-url');
        const keyInput = document.getElementById('db-key');
        if (urlInput) urlInput.value = savedUrl;
        if (keyInput) keyInput.value = savedKey;
        attemptUnlock();
    }
};

window.attemptUnlock = async function() {
    const url = document.getElementById('db-url')?.value.trim();
    const key = document.getElementById('db-key')?.value.trim();

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
        console.error('Auth Error:', err);
        alert('連線失敗！請確認 Supabase 網址正確且貼上的是最高權限私鑰 (Service Role)。\n' + err.message);
    }
};

window.lockAndLogOut = function() {
    if (confirm('確認安全登出控制台並清除本地暫存憑證嗎？')) {
        sessionStorage.clear();
        window.location.reload();
    }
};

async function refreshAllAdminData() {
    if (!supabase) return;
    try {
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
    } catch (err) {
        console.error('Sync Error:', err);
    }
}

window.switchAdminTab = function(tabName) {
    currentTab = tabName;
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    const targetBtn = document.getElementById(`tab-btn-${tabName}`);
    if (targetBtn) targetBtn.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const targetContent = document.getElementById(`tab-content-${tabName}`);
    if (targetContent) targetContent.classList.add('active');

    if (tabName === 'review') {
        fetchAndRenderReviewFeed();
    }
    if (tabName === 'analysis') {
        initAnalysisTab();
    }
};

window.backfillImpactFields = async function() {
    const textarea = document.getElementById('backfill-json-paste-area');
    const rawText = textarea.value.trim();
    const btn = document.getElementById('btn-execute-backfill');

    if (!rawText) {
        alert('請先貼上 Gemini 產出的回填 JSON 陣列！');
        return;
    }

    let itemsArray;
    try {
        itemsArray = JSON.parse(rawText);
    } catch (e) {
        alert('JSON 格式錯誤，請確認貼上的內容是完整的 JSON 陣列。');
        return;
    }

    if (!Array.isArray(itemsArray)) {
        alert('匯入格式有誤：外層必須是方括號包覆的陣列 [ ... ]！');
        return;
    }

    const missingId = itemsArray.some(item => !item.id);
    if (missingId) {
        alert('偵測到有項目缺少 id，回填必須依 id 對應既有事件，請確認 Gemini 輸出內容完整。');
        return;
    }

    if (!confirm(`偵測到 ${itemsArray.length} 筆回填資料，確認開始依 id 更新既有事件嗎？（只會更新影響相關欄位，不影響其他資料）`)) return;

    btn.disabled = true;
    btn.innerHTML = '⚡ 回填更新中...請勿關閉視窗';

    let successCount = 0;
    let failCount = 0;

    for (const item of itemsArray) {
        const { error } = await supabase.from('events').update({
            people_impact: item.people_impact || null,
            people_impact_score: (item.people_impact_score !== undefined && item.people_impact_score !== null) ? parseInt(item.people_impact_score) : null,
            national_security_impact: item.national_security_impact || null,
            national_impact_score: (item.national_impact_score !== undefined && item.national_impact_score !== null) ? parseInt(item.national_impact_score) : null
        }).eq('id', item.id);

        if (error) {
            console.error(`回填失敗 (id: ${item.id}):`, error);
            failCount++;
        } else {
            successCount++;
        }
    }

    btn.disabled = false;
    btn.innerHTML = '🩹 執行回填更新';
    textarea.value = '';
    alert(`回填完成！成功 ${successCount} 筆，失敗 ${failCount} 筆${failCount > 0 ? '（請查看 Console 確認失敗原因）' : ''}。`);
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
        let polMappingFailures = 0;
        let autoAddedPols = 0;

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
                response_summary: item.response_summary || null,
                people_impact: item.people_impact || null,
                people_impact_score: item.people_impact_score || null,
                national_security_impact: item.national_security_impact || null,
                national_impact_score: item.national_impact_score || null,
                date: item.date || null,
                source_url: item.source_url || null,
                is_visible: false,
                is_reviewed: false
            }).select().single();

            if (evErr) {
                console.error('Event Insert Failed:', evErr);
                continue;
            }

            if (newEvent) {
                const sourcesToInsert = [];
                if (item.source_url) sourcesToInsert.push({ event_id: newEvent.id, media_name: item.source_media_name || '未命名來源', url: item.source_url });
                if (item.alt_source_url) sourcesToInsert.push({ event_id: newEvent.id, media_name: item.alt_source_media_name || '未命名來源', url: item.alt_source_url });
                if (sourcesToInsert.length > 0) {
                    await supabase.from('event_sources').insert(sourcesToInsert);
                }

                if (issueId) {
                    await supabase.from('event_issue_map').insert({ event_id: newEvent.id, issue_id: issueId });
                }
                
                if (item.politician_name) {
                    let politician = cachePoliticians.find(p => p.name === item.politician_name.trim());
                    
                    if (!politician) {
                        const { data: newPol, error: polErr } = await supabase
                            .from('politicians')
                            .insert({ name: item.politician_name.trim(), party: '未知政黨' })
                            .select()
                            .single();
                        
                        if (newPol && !polErr) {
                            cachePoliticians.push(newPol);
                            politician = newPol;
                            autoAddedPols++;
                        }
                    }

                    if (politician) {
                        await supabase.from('event_politician_map').insert({ event_id: newEvent.id, politician_id: politician.id });
                    } else {
                        polMappingFailures++;
                    }
                }
                successCount++;
            }
        }

        alert(`批次操作完成\n成功匯入：${successCount} 筆\n自動補齊人物：${autoAddedPols} 位\n配對失敗：${polMappingFailures} 筆`);
        textarea.value = '';
        await refreshAllAdminData();

    } catch (err) {
        alert('解析失敗：' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '🚀 執行強效大數據匯入';
    }
};

function renderSettingsLists() {
    const polList = document.getElementById('list-politicians');
    if (polList) {
        polList.innerHTML = cachePoliticians.map(p => `
            <div class="item-row">
                <div class="item-row-left">
                    <span class="item-title">👤 ${p.name}</span>
                    <span class="item-sub">${p.party || '未知政黨'}</span>
                </div>
                <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deletePolitician('${p.id}')">刪除</button>
            </div>
        `).join('');
    }

    const issueList = document.getElementById('list-issues');
    if (issueList) {
        issueList.innerHTML = cacheIssues.map(i => `
            <div class="item-row">
                <div class="item-row-left">
                    <span class="item-title">📌 ${i.name}</span>
                </div>
                <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deleteIssue('${i.id}')">刪除</button>
            </div>
        `).join('');
    }
}

window.addPolitician = async function() {
    const name = document.getElementById('new-pol-name').value.trim();
    const party = document.getElementById('new-pol-party').value.trim();
    if (!name || !supabase) return;
    await supabase.from('politicians').insert({ name, party });
    document.getElementById('new-pol-name').value = '';
    document.getElementById('new-pol-party').value = '';
    await refreshAllAdminData();
};

window.deletePolitician = async function(id) {
    if (confirm('確定刪除此人物嗎？') && supabase) {
        await supabase.from('politicians').delete().eq('id', id);
        await refreshAllAdminData();
    }
};

window.addIssue = async function() {
    const name = document.getElementById('new-issue-name').value.trim();
    if (!name || !supabase) return;
    await supabase.from('issues').insert({ name });
    document.getElementById('new-issue-name').value = '';
    await refreshAllAdminData();
};

window.deleteIssue = async function(id) {
    if (confirm('確定刪除此議題嗎？') && supabase) {
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

window.setPoliticianFilter = function(polId) {
    currentPolFilter = polId;
    renderFilteredReviewList();
};

async function fetchAndRenderReviewFeed() {
    const container = document.getElementById('review-list-container');
    container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 2rem;">資料檢索中...</div>';

    let query = supabase.from('events').select('*, event_politician_map ( politician_id, politicians ( name ) ), event_issue_map ( issue_id, issues ( name ) ), event_sources ( id, media_name, url )');

    if (currentEventFilter === 'pending') {
        query = query.eq('is_visible', false).eq('is_reviewed', false);
    } else if (currentEventFilter === 'staged') {
        query = query.eq('is_visible', false).eq('is_reviewed', true);
    } else if (currentEventFilter === 'approved') {
        query = query.eq('is_visible', true);
    }

    const { data, error } = await query.order('date', { ascending: false });

    if (error) {
        container.innerHTML = `<div style="color:var(--danger);">讀取失敗：${error.message}</div>`;
        return;
    }

    currentFetchedEvents = data || [];
    renderFilterUI();
    renderFilteredReviewList();
}

function renderFilterUI() {
    const container = document.getElementById('review-list-container');
    let filterBar = document.getElementById('review-dynamic-filters');
    if (!filterBar) {
        filterBar = document.createElement('div');
        filterBar.id = 'review-dynamic-filters';
        filterBar.style.marginBottom = '1.5rem';
        filterBar.style.padding = '1rem';
        filterBar.style.background = '#f8fafc';
        filterBar.style.borderRadius = '8px';
        container.parentNode.insertBefore(filterBar, container);
    }

    filterBar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
            <label for="politician-filter" style="font-weight: bold; font-size: 0.9rem;">👤 依人物過濾：</label>
            <select id="politician-filter" class="form-input" style="width: auto; margin-bottom: 0;" onchange="setPoliticianFilter(this.value)">
                <option value="all" ${currentPolFilter === 'all' ? 'selected' : ''}>-- 全部人物 --</option>
                ${cachePoliticians.map(p => `<option value="${p.id}" ${currentPolFilter === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
            </select>
            <span style="font-size: 0.85rem; color: #64748b; margin-left: auto;">
                筆數：<span id="filtered-count">0</span>
            </span>
        </div>
    `;
}

function renderFilteredReviewList() {
    const container = document.getElementById('review-list-container');
    
    let filtered = currentFetchedEvents;
    if (currentPolFilter !== 'all') {
        filtered = currentFetchedEvents.filter(ev => 
            ev.event_politician_map?.some(m => m.politician_id === currentPolFilter)
        );
    }

    // 🌟 強制前端依據日期（年月）降冪排序，確保匯入的資料排列正確
    filtered.sort((a, b) => {
        const dateA = a.date ? new Date(a.date).getTime() : 0;
        const dateB = b.date ? new Date(b.date).getTime() : 0;
        return dateB - dateA; 
    });

    const countDisplay = document.getElementById('filtered-count');
    if (countDisplay) countDisplay.innerText = filtered.length;

    if (filtered.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:3rem; color:var(--text-muted);">目前無符合篩選條件的事件。</div>`;
        return;
    }

    container.innerHTML = filtered.map(e => {
        const polNames = e.event_politician_map?.map(m => m.politicians?.name).filter(Boolean).join(', ') || '未掛名人物';
        const issueNames = e.event_issue_map?.map(m => m.issues?.name).filter(Boolean).join(', ') || '未設定議題';
        
        let actionButtons = '';
        if (currentEventFilter === 'pending') {
            actionButtons += `<button class="btn btn-secondary" onclick="updateEventState('${e.id}', true, false)">🟡 <span class="hide-on-mobile">移至</span>暫存</button>`;
            actionButtons += `<button class="btn btn-success" onclick="updateEventState('${e.id}', true, true)">🟢 <span class="hide-on-mobile">直接</span>上架</button>`;
        } else if (currentEventFilter === 'staged') {
            actionButtons += `<button class="btn btn-secondary" onclick="updateEventState('${e.id}', false, false)">🔴 <span class="hide-on-mobile">退回</span>待審</button>`;
            actionButtons += `<button class="btn btn-success" onclick="updateEventState('${e.id}', true, true)">🟢 <span class="hide-on-mobile">正式</span>上架</button>`;
        } else if (currentEventFilter === 'approved') {
            actionButtons += `<button class="btn btn-secondary" onclick="updateEventState('${e.id}', true, false)">🟡 <span class="hide-on-mobile">下架轉</span>暫存</button>`;
        }

        return `
            <div class="review-card">
                <div class="review-card-meta">
                    <span class="review-badge">📅 ${e.date || '日期未明'}</span>
                    <span class="review-badge">👤 ${polNames}</span>
                    <span class="review-badge">📌 ${issueNames}</span>
                </div>
                <h3 style="margin: 10px 0; font-size:1.15rem;">「${e.quote}」</h3>
                <p style="color: #475569; font-size:0.9rem; margin-bottom:1rem;">${e.context || '無描述脈絡。'}</p>
                ${e.response_summary ? `<div style="font-size:0.85rem; color:var(--text-muted); font-style:italic; margin-bottom:1rem;">🗣️ 當事人回應：${e.response_summary}</div>` : ''}
                ${e.people_impact ? `<div style="background:#eff6ff; border-left:4px solid #2563eb; padding:8px 12px; font-size:0.9rem; margin-bottom:1rem; border-radius:0 6px 6px 0;">💥 對人民的影響：${e.people_impact}</div>` : ''}
                ${e.national_security_impact ? `<div style="background:#fef2f2; border-left:4px solid #dc2626; padding:8px 12px; font-size:0.9rem; margin-bottom:1rem; border-radius:0 6px 6px 0;">🛡️ 對國安的影響：${e.national_security_impact}</div>` : ''}
                ${(e.event_sources && e.event_sources.length > 0) ? e.event_sources.map(src => `<div style="font-size: 0.85rem; margin-bottom: 0.5rem;"><a href="${src.url}" target="_blank" style="color: #3b82f6; text-decoration: underline;">🔗 [${src.media_name}] 來源佐證連結</a></div>`).join('') : (e.source_url ? `<div style="font-size: 0.85rem; margin-bottom: 0.5rem;"><a href="${e.source_url}" target="_blank" style="color: #3b82f6; text-decoration: underline;">🔗 來源佐證連結</a></div>` : '')}
                <div class="review-actions">
                    <button class="btn btn-secondary" onclick="openEditModal('${e.id}')">✏️ <span class="hide-on-mobile">編輯</span></button>
                    ${actionButtons}
                    <button class="btn btn-danger" onclick="deleteEventAbsolute('${e.id}')">🗑️ <span class="hide-on-mobile">刪除</span></button>
                </div>
            </div>
        `;
    }).join('');
}

window.updateEventState = async function(id, isReviewed, isVisible) {
    if (!supabase) return;
    const { error } = await supabase.from('events').update({ is_reviewed: isReviewed, is_visible: isVisible }).eq('id', id);
    if (error) alert('狀態切換失敗: ' + error.message);
    await fetchAndRenderReviewFeed();
};

window.publishAllPending = async function() {
    if (currentEventFilter === 'approved') {
        alert('請先切換到待審核或暫存區再執行操作。');
        return;
    }

    let visibleEvents = currentFetchedEvents;
    if (currentPolFilter !== 'all') {
        visibleEvents = currentFetchedEvents.filter(ev => 
            ev.event_politician_map?.some(m => m.politician_id === currentPolFilter)
        );
    }

    const pendingIds = visibleEvents.map(e => e.id);

    if (pendingIds.length === 0) {
        alert('目前條件下沒有可上架的事件。');
        return;
    }

    if (!confirm(`確定要將目前篩選出的 ${pendingIds.length} 筆事件全部上架嗎？`)) return;

    const batchSize = 50;
    let successCount = 0;

    for (let i = 0; i < pendingIds.length; i += batchSize) {
        const chunk = pendingIds.slice(i, i + batchSize);
        const { error } = await supabase.from('events').update({ is_visible: true, is_reviewed: true }).in('id', chunk);

        if (error) {
            alert(`中斷。已完成 ${successCount} 筆。錯誤：${error.message}`);
            await fetchAndRenderReviewFeed();
            return;
        }
        successCount += chunk.length;
    }

    alert(`已成功上架 ${successCount} 筆事件。`);
    await fetchAndRenderReviewFeed();
};

window.deleteAllPending = async function() {
    if (currentEventFilter === 'approved') {
        alert('請先切換到待審核或暫存區再執行操作。');
        return;
    }

    let visibleEvents = currentFetchedEvents;
    let polNameDisplay = '全部人物';

    if (currentPolFilter !== 'all') {
        visibleEvents = currentFetchedEvents.filter(ev => 
            ev.event_politician_map?.some(m => m.politician_id === currentPolFilter)
        );
        const targetPol = cachePoliticians.find(p => p.id === currentPolFilter);
        if (targetPol) polNameDisplay = targetPol.name;
    }

    const pendingIds = visibleEvents.map(e => e.id);

    if (pendingIds.length === 0) {
        alert(`目前條件下沒有可刪除的事件。`);
        return;
    }

    if (!confirm(`確定要永久刪除【${polNameDisplay}】共 ${pendingIds.length} 筆事件嗎？`)) {
        return;
    }

    const batchSize = 50;
    let successCount = 0;

    for (let i = 0; i < pendingIds.length; i += batchSize) {
        const chunk = pendingIds.slice(i, i + batchSize);
        const { error } = await supabase.from('events').delete().in('id', chunk);

        if (error) {
            alert(`中斷。已刪除 ${successCount} 筆。錯誤：${error.message}`);
            await fetchAndRenderReviewFeed();
            return;
        }
        successCount += chunk.length;
    }

    alert(`成功刪除 ${successCount} 筆資料。`);
    await fetchAndRenderReviewFeed();
};

window.openEditModal = async function(eventId) {
    const ev = currentFetchedEvents.find(e => e.id === eventId);
    if (!ev) return;

    document.getElementById('edit-event-id').value = ev.id;
    document.getElementById('edit-quote').value = ev.quote;
    document.getElementById('edit-date').value = ev.date || '';
    document.getElementById('edit-context').value = ev.context || '';
    document.getElementById('edit-response-summary').value = ev.response_summary || '';
    document.getElementById('edit-people-impact').value = ev.people_impact || '';
    document.getElementById('edit-people-impact-score').value = (ev.people_impact_score !== null && ev.people_impact_score !== undefined) ? ev.people_impact_score : '';
    document.getElementById('edit-national-security-impact').value = ev.national_security_impact || '';
    document.getElementById('edit-national-impact-score').value = (ev.national_impact_score !== null && ev.national_impact_score !== undefined) ? ev.national_impact_score : '';
    const sources = ev.event_sources || [];
    document.getElementById('edit-source-media').value = sources[0]?.media_name || '';
    document.getElementById('edit-source-url').value = sources[0]?.url || ev.source_url || '';
    document.getElementById('edit-alt-source-media').value = sources[1]?.media_name || '';
    document.getElementById('edit-alt-source-url').value = sources[1]?.url || '';

    const activePolIds = ev.event_politician_map?.map(m => m.politician_id) || [];
    const checkboxContainer = document.getElementById('edit-politicians-checkboxes');
    checkboxContainer.innerHTML = cachePoliticians.map(p => `
        <label class="checkbox-label">
            <input type="checkbox" name="edit-pol-box" value="${p.id}" ${activePolIds.includes(p.id) ? 'checked' : ''}> ${p.name}
        </label>
    `).join('');

    const currentIssueId = ev.event_issue_map?.[0]?.issue_id || '';
    const issueSelect = document.getElementById('edit-issue-select');
    let issueOptions = '<option value="">-- 未選定 / 無特定議題 --</option>';
    cacheIssues.forEach(i => {
        issueOptions += `<option value="${i.id}" ${i.id === currentIssueId ? 'selected' : ''}>📌 ${i.name}</option>`;
    });
    issueSelect.innerHTML = issueOptions;

    document.getElementById('edit-modal').classList.add('active');
};

window.closeEditModal = function() {
    document.getElementById('edit-modal').classList.remove('active');
};

window.saveEventEdits = async function() {
    if (!supabase) return;
    const id = document.getElementById('edit-event-id').value;
    
    const updatePayload = {
        quote: document.getElementById('edit-quote').value.trim(),
        date: document.getElementById('edit-date').value || null,
        context: document.getElementById('edit-context').value.trim(),
        response_summary: document.getElementById('edit-response-summary').value.trim() || null,
        people_impact: document.getElementById('edit-people-impact').value.trim() || null,
        people_impact_score: document.getElementById('edit-people-impact-score').value ? parseInt(document.getElementById('edit-people-impact-score').value) : null,
        national_security_impact: document.getElementById('edit-national-security-impact').value.trim() || null,
        national_impact_score: document.getElementById('edit-national-impact-score').value ? parseInt(document.getElementById('edit-national-impact-score').value) : null,
        source_url: document.getElementById('edit-source-url').value.trim() || null
    };

    const { error: mainErr } = await supabase.from('events').update(updatePayload).eq('id', id);
    if (mainErr) {
        alert('儲存失敗: ' + mainErr.message);
        return;
    }

    // 同步更新來源表（主要來源 + 交叉查證來源）
    await supabase.from('event_sources').delete().eq('event_id', id);
    const sourcesToInsert = [];
    const mainMedia = document.getElementById('edit-source-media').value.trim();
    const mainUrl = document.getElementById('edit-source-url').value.trim();
    const altMedia = document.getElementById('edit-alt-source-media').value.trim();
    const altUrl = document.getElementById('edit-alt-source-url').value.trim();
    if (mainUrl) sourcesToInsert.push({ event_id: id, media_name: mainMedia || '未命名來源', url: mainUrl });
    if (altUrl) sourcesToInsert.push({ event_id: id, media_name: altMedia || '未命名來源', url: altUrl });
    if (sourcesToInsert.length > 0) {
        await supabase.from('event_sources').insert(sourcesToInsert);
    }

    await supabase.from('event_politician_map').delete().eq('event_id', id);
    const checkedPols = Array.from(document.querySelectorAll('input[name="edit-pol-box"]:checked')).map(box => ({
        event_id: id,
        politician_id: box.value
    }));
    if (checkedPols.length > 0) {
        await supabase.from('event_politician_map').insert(checkedPols);
    }

    await supabase.from('event_issue_map').delete().eq('event_id', id);
    const chosenIssueId = document.getElementById('edit-issue-select').value;
    if (chosenIssueId) {
        await supabase.from('event_issue_map').insert({ event_id: id, issue_id: chosenIssueId });
    }

    alert('資料校正儲存成功');
    closeEditModal();
    await fetchAndRenderReviewFeed();
};

window.deleteEventAbsolute = async function(id) {
    if (confirm('確定要永久刪除這筆事件嗎？此動作將同時移除所有中介表關聯。') && supabase) {
        const { error } = await supabase.from('events').delete().eq('id', id);
        if (error) alert('刪除失敗: ' + error.message);
        await fetchAndRenderReviewFeed();
    }
};

// ===== 分析與紀錄管理 =====
let cacheEventsForAnalysis = [];

async function initAnalysisTab() {
    const polSelect = document.getElementById('analysis-politician-select');
    polSelect.innerHTML = '<option value="">請選擇政治人物</option>' +
        cachePoliticians.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    document.getElementById('analysis-politician-content').value = '';

    if (cacheEventsForAnalysis.length === 0) {
        const { data } = await supabase.from('events').select('id, quote, date').order('date', { ascending: false });
        cacheEventsForAnalysis = data || [];
    }
    renderEventAnalysisOptions(cacheEventsForAnalysis);
    document.getElementById('analysis-event-content').value = '';
    document.getElementById('analysis-event-search').value = '';

    await refreshAnalysisLists();
}

function renderEventAnalysisOptions(list) {
    const evSelect = document.getElementById('analysis-event-select');
    evSelect.innerHTML = '<option value="">請選擇事件</option>' +
        list.map(e => `<option value="${e.id}">「${(e.quote || '未命名事件').slice(0, 30)}」（${e.date || '無日期'}）</option>`).join('');
}

window.filterEventAnalysisSelect = function() {
    const term = document.getElementById('analysis-event-search').value.trim().toLowerCase();
    const filtered = term ? cacheEventsForAnalysis.filter(e => (e.quote || '').toLowerCase().includes(term)) : cacheEventsForAnalysis;
    renderEventAnalysisOptions(filtered);
};

window.loadPoliticianAnalysisIntoForm = async function() {
    const polId = document.getElementById('analysis-politician-select').value;
    const textarea = document.getElementById('analysis-politician-content');
    if (!polId) { textarea.value = ''; return; }
    const { data } = await supabase.from('politician_analysis').select('content').eq('politician_id', polId).maybeSingle();
    textarea.value = data?.content || '';
};

window.savePoliticianAnalysis = async function() {
    const polId = document.getElementById('analysis-politician-select').value;
    const content = document.getElementById('analysis-politician-content').value.trim();
    if (!polId) { alert('請先選擇政治人物！'); return; }
    if (!content) { alert('分析內容不能是空的！'); return; }

    const { error } = await supabase.from('politician_analysis').upsert(
        { politician_id: polId, content, is_visible: true },
        { onConflict: 'politician_id' }
    );
    if (error) { alert('儲存失敗：' + error.message); return; }
    alert('人物分析已儲存！');
    await refreshAnalysisLists();
};

window.deletePoliticianAnalysis = async function() {
    const polId = document.getElementById('analysis-politician-select').value;
    if (!polId) { alert('請先選擇政治人物！'); return; }
    if (!confirm('確定要刪除這位人物的風格分析嗎？')) return;
    const { error } = await supabase.from('politician_analysis').delete().eq('politician_id', polId);
    if (error) { alert('刪除失敗：' + error.message); return; }
    document.getElementById('analysis-politician-content').value = '';
    alert('已刪除！');
    await refreshAnalysisLists();
};

window.loadEventAnalysisIntoForm = async function() {
    const evId = document.getElementById('analysis-event-select').value;
    const textarea = document.getElementById('analysis-event-content');
    if (!evId) { textarea.value = ''; return; }
    const { data } = await supabase.from('event_analysis').select('content').eq('event_id', evId).maybeSingle();
    textarea.value = data?.content || '';
};

window.saveEventAnalysis = async function() {
    const evId = document.getElementById('analysis-event-select').value;
    const content = document.getElementById('analysis-event-content').value.trim();
    if (!evId) { alert('請先選擇事件！'); return; }
    if (!content) { alert('解讀內容不能是空的！'); return; }

    const { error } = await supabase.from('event_analysis').upsert(
        { event_id: evId, content, is_visible: true },
        { onConflict: 'event_id' }
    );
    if (error) { alert('儲存失敗：' + error.message); return; }
    alert('事件解讀已儲存！');
    await refreshAnalysisLists();
};

window.deleteEventAnalysis = async function() {
    const evId = document.getElementById('analysis-event-select').value;
    if (!evId) { alert('請先選擇事件！'); return; }
    if (!confirm('確定要刪除這則事件解讀嗎？')) return;
    const { error } = await supabase.from('event_analysis').delete().eq('event_id', evId);
    if (error) { alert('刪除失敗：' + error.message); return; }
    document.getElementById('analysis-event-content').value = '';
    alert('已刪除！');
    await refreshAnalysisLists();
};

async function refreshAnalysisLists() {
    const { data: polAnalyses } = await supabase.from('politician_analysis').select('politician_id, content, politicians(name)');
    const polListEl = document.getElementById('list-politician-analysis');
    if (polListEl) {
        polListEl.innerHTML = (polAnalyses && polAnalyses.length > 0) ? polAnalyses.map(a => `
            <div class="item-row">
                <div class="item-row-left">
                    <span class="item-title">${a.politicians?.name || '未知人物'}</span>
                    <span class="item-sub">${(a.content || '').slice(0, 40)}...</span>
                </div>
            </div>
        `).join('') : '<div style="text-align:center; color:var(--text-muted); padding:1rem;">尚無人物分析</div>';
    }

    const { data: evAnalyses } = await supabase.from('event_analysis').select('event_id, content, events(quote)');
    const evListEl = document.getElementById('list-event-analysis');
    if (evListEl) {
        evListEl.innerHTML = (evAnalyses && evAnalyses.length > 0) ? evAnalyses.map(a => `
            <div class="item-row">
                <div class="item-row-left">
                    <span class="item-title">「${a.events?.quote || '未知事件'}」</span>
                    <span class="item-sub">${(a.content || '').slice(0, 40)}...</span>
                </div>
            </div>
        `).join('') : '<div style="text-align:center; color:var(--text-muted); padding:1rem;">尚無事件解讀</div>';
    }
}

