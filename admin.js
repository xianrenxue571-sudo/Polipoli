import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let supabase = null;
let currentTab = 'settings';
let currentEventFilter = 'pending';
let currentFeedbackFilter = 'unread';
let majorEventSources = [];
let editingMajorEventId = null;
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
        // 預設分頁是「新增與管理」，這裡手動補初始化一次事件解讀／站長觀點表單，
        // 因為初次解鎖不會走 switchAdminTab 那條路徑。
        await initAnalysisTab();
        await initEditorTakesTab();
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

    if (tabName === 'settings') {
        initAnalysisTab();
        initEditorTakesTab();
    }
    if (tabName === 'review') {
        fetchAndRenderReviewFeed();
    }
    if (tabName === 'feedback') {
        initFeedbackTab();
        refreshTakeCommentsList();
    }
    if (tabName === 'majorEvents') {
        initMajorEventsTab();
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
            national_impact_score: (item.national_impact_score !== undefined && item.national_impact_score !== null) ? parseInt(item.national_impact_score) : null,
            score_reason: item.score_reason !== undefined ? item.score_reason : null
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
                score_reason: item.score_reason || null,
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
                <div style="display:flex; align-items:center; gap:10px;">
                    <label class="checkbox-label" style="font-size:0.8rem; white-space:nowrap;">
                        <input type="checkbox" ${p.is_hard_to_type ? 'checked' : ''} onchange="toggleHardToType('${p.id}', this.checked)"> 難檢字
                    </label>
                    <button class="btn btn-danger" style="padding: 4px 8px; font-size:0.8rem;" onclick="deletePolitician('${p.id}')">刪除</button>
                </div>
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

window.toggleHardToType = async function(id, checked) {
    if (!supabase) return;
    const { error } = await supabase.from('politicians').update({ is_hard_to_type: checked }).eq('id', id);
    if (error) {
        alert('更新「難檢字」標記失敗：' + error.message);
        await refreshAllAdminData(); // 失敗時重新拉一次資料，把畫面上的勾選狀態還原成資料庫實際狀態
        return;
    }
    const p = cachePoliticians.find(pol => pol.id === id);
    if (p) p.is_hard_to_type = checked; // 直接更新本地快取，不用整包重新抓一次
};

window.addPolitician = async function() {
    const name = document.getElementById('new-pol-name').value.trim();
    const party = document.getElementById('new-pol-party').value.trim();
    const isHardToType = document.getElementById('new-pol-hard-to-type').checked;
    if (!name || !supabase) return;
    await supabase.from('politicians').insert({ name, party, is_hard_to_type: isHardToType });
    document.getElementById('new-pol-name').value = '';
    document.getElementById('new-pol-party').value = '';
    document.getElementById('new-pol-hard-to-type').checked = false;
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
    const dupBtn = document.getElementById('btn-check-duplicates');
    if (dupBtn) dupBtn.style.display = filterType === 'pending' ? 'inline-flex' : 'none';
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
    const scoreReason = ev.score_reason || {};
    document.getElementById('edit-score-reason-positive').value = scoreReason.positive_factors || '';
    document.getElementById('edit-score-reason-limiting').value = scoreReason.limiting_factors || '';
    document.getElementById('edit-score-reason-excluded').value = scoreReason.excluded_factors || '';
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

    const srPositive = document.getElementById('edit-score-reason-positive').value.trim();
    const srLimiting = document.getElementById('edit-score-reason-limiting').value.trim();
    const srExcluded = document.getElementById('edit-score-reason-excluded').value.trim();
    const scoreReasonPayload = (srPositive || srLimiting || srExcluded) ? {
        positive_factors: srPositive || null,
        limiting_factors: srLimiting || null,
        excluded_factors: srExcluded || null
    } : null;

    const updatePayload = {
        score_reason: scoreReasonPayload,
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

// ===== 檢查重複功能 =====
let dupPendingEvents = [];
let dupIgnorePairs = new Set();
let dupResults = { red: [], yellow: [] };
let dupCurrentTier = null;
let dupCurrentList = [];
let dupCurrentIndex = 0;

function pairKey(idA, idB) {
    return [idA, idB].sort().join('|');
}

function charJaccardSimilarity(textA, textB) {
    const clean = (t) => (t || '').replace(/[，。！？「」『』、：；（）()\[\]\s"'""'']/g, '');
    const setA = new Set(clean(textA).split(''));
    const setB = new Set(clean(textB).split(''));
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    setA.forEach(ch => { if (setB.has(ch)) intersection++; });
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}

function dayDiff(dateA, dateB) {
    if (!dateA || !dateB) return Infinity;
    const a = new Date(dateA);
    const b = new Date(dateB);
    return Math.abs((a - b) / (1000 * 60 * 60 * 24));
}

window.startDuplicateCheck = async function() {
    document.getElementById('dup-check-modal').classList.add('active');
    document.getElementById('dup-view-overview').style.display = 'block';
    document.getElementById('dup-view-list').style.display = 'none';
    document.getElementById('dup-view-detail').style.display = 'none';
    document.getElementById('dup-overview-loading').style.display = 'block';
    document.getElementById('dup-overview-content').style.display = 'none';

    const selectClause = '*, event_politician_map ( politician_id, politicians ( name ) ), event_issue_map ( issue_id, issues ( name ) )';

    const [{ data: pendingData }, { data: poolData }, { data: ignoreData }] = await Promise.all([
        supabase.from('events').select(selectClause).eq('is_visible', false).eq('is_reviewed', false),
        supabase.from('events').select(selectClause).or('is_visible.eq.true,is_reviewed.eq.true'),
        supabase.from('duplicate_ignore_pairs').select('event_id_a, event_id_b')
    ]);

    dupPendingEvents = pendingData || [];
    const poolEvents = poolData || [];
    dupIgnorePairs = new Set((ignoreData || []).map(p => pairKey(p.event_id_a, p.event_id_b)));

    const stagedCount = poolEvents.filter(e => e.is_visible === false && e.is_reviewed === true).length;
    const approvedCount = poolEvents.filter(e => e.is_visible === true).length;

    dupResults = { red: [], yellow: [] };

    dupPendingEvents.forEach(pending => {
        const pendingPolNames = (pending.event_politician_map || []).map(m => m.politicians?.name).filter(Boolean);
        const pendingIssueNames = (pending.event_issue_map || []).map(m => m.issues?.name).filter(Boolean);
        if (pendingPolNames.length === 0) return;

        let bestMatch = null;
        let bestTier = null;
        let bestBasis = null;

        poolEvents.forEach(pool => {
            const key = pairKey(pending.id, pool.id);
            if (dupIgnorePairs.has(key)) return;

            const poolPolNames = (pool.event_politician_map || []).map(m => m.politicians?.name).filter(Boolean);
            const samePol = pendingPolNames.some(n => poolPolNames.includes(n));
            if (!samePol) return;

            const poolIssueNames = (pool.event_issue_map || []).map(m => m.issues?.name).filter(Boolean);
            const sameIssue = pendingIssueNames.some(n => poolIssueNames.includes(n));
            const diff = dayDiff(pending.date, pool.date);
            const overlap = charJaccardSimilarity(pending.quote, pool.quote);
            const sourceMatch = pending.source_url && pool.source_url && pending.source_url === pool.source_url;

            let tier = null;
            if (sourceMatch || (diff <= 3 && overlap >= 0.5)) {
                tier = 'red';
            } else if (diff <= 7 && overlap >= 0.25) {
                tier = 'yellow';
            }
            if (!tier) return;

            const tierRank = { red: 2, yellow: 1 };
            if (!bestTier || tierRank[tier] > tierRank[bestTier] || (tier === bestTier && overlap > (bestBasis?.overlap || 0))) {
                bestTier = tier;
                bestMatch = pool;
                bestBasis = { samePol, sameIssue, sourceMatch, diff, overlap };
            }
        });

        if (bestTier) {
            dupResults[bestTier].push({ pending, match: bestMatch, basis: bestBasis });
        }
    });

    document.getElementById('dup-total-pending').textContent = dupPendingEvents.length;
    document.getElementById('dup-total-staged').textContent = stagedCount;
    document.getElementById('dup-total-approved').textContent = approvedCount;
    document.getElementById('dup-count-red').textContent = dupResults.red.length;
    document.getElementById('dup-count-yellow').textContent = dupResults.yellow.length;
    document.getElementById('dup-count-grey').textContent = dupPendingEvents.length - dupResults.red.length - dupResults.yellow.length;

    document.getElementById('dup-overview-loading').style.display = 'none';
    document.getElementById('dup-overview-content').style.display = 'block';
};

window.closeDupCheckModal = function() {
    document.getElementById('dup-check-modal').classList.remove('active');
};

window.backToDupOverview = function() {
    document.getElementById('dup-view-list').style.display = 'none';
    document.getElementById('dup-view-detail').style.display = 'none';
    document.getElementById('dup-view-overview').style.display = 'block';
};

window.backToDupList = function() {
    document.getElementById('dup-view-detail').style.display = 'none';
    document.getElementById('dup-view-list').style.display = 'block';
};

window.showDupList = function(tier) {
    dupCurrentTier = tier;
    dupCurrentList = dupResults[tier];
    document.getElementById('dup-view-overview').style.display = 'none';
    document.getElementById('dup-view-list').style.display = 'block';

    const container = document.getElementById('dup-list-container');
    if (dupCurrentList.length === 0) {
        container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:2rem;">這個分類目前沒有項目</div>';
        return;
    }

    const dotColor = tier === 'red' ? '🔴' : '🟡';
    container.innerHTML = dupCurrentList.map((item, idx) => {
        const tags = [];
        if (item.basis.samePol) tags.push('人物✓');
        if (item.basis.diff <= 7) tags.push('日期✓');
        if (item.basis.sourceMatch) tags.push('來源✓');
        tags.push(`關鍵字重疊${Math.round(item.basis.overlap * 100)}%`);
        return `
            <div class="review-card" style="margin-bottom:1rem;">
                <div class="item-title">${dotColor} 待審核｜${item.pending.event_politician_map?.[0]?.politicians?.name || '未知人物'}｜${item.pending.date || '無日期'}</div>
                <div style="margin:6px 0;">「${item.pending.quote}」</div>
                <div style="font-size:0.85rem; color:var(--text-muted);">疑似撞：${item.match.is_visible ? '已核准' : '暫存區'} #${item.match.id.slice(0, 8)}</div>
                <div style="font-size:0.8rem; color:var(--text-muted); margin:4px 0;">相似度依據：${tags.join('・')}</div>
                <button class="btn btn-secondary" style="margin-top:8px;" onclick="viewDupDetail(${idx})">查看比對 ›</button>
            </div>
        `;
    }).join('');
};

function renderDupEventBlock(e) {
    return `
        <div><strong>日期：</strong>${e.date || '無日期'}</div>
        <div><strong>quote：</strong>${e.quote}</div>
        <div><strong>來源：</strong>${e.source_url ? `<a href="${e.source_url}" target="_blank">${e.source_url}</a>` : '無'}</div>
        <div style="margin-top:8px;"><strong>context：</strong></div>
        <div style="color:#475569;">${e.context || '無'}</div>
    `;
}

window.viewDupDetail = function(index) {
    dupCurrentIndex = index;
    document.getElementById('dup-view-list').style.display = 'none';
    document.getElementById('dup-view-detail').style.display = 'block';
    renderCurrentDupDetail();
};

function renderCurrentDupDetail() {
    const item = dupCurrentList[dupCurrentIndex];
    document.getElementById('dup-detail-position').textContent = `${dupCurrentIndex + 1}/${dupCurrentList.length}`;
    document.getElementById('dup-detail-title').textContent = `${item.pending.event_politician_map?.[0]?.politicians?.name || '未知人物'}｜疑似重複`;

    const tags = [];
    if (item.basis.samePol) tags.push('人物相同');
    if (item.basis.diff <= 7) tags.push('日期相近');
    if (item.basis.sourceMatch) tags.push('來源網址相同');
    tags.push(`關鍵字重疊${Math.round(item.basis.overlap * 100)}%`);
    document.getElementById('dup-detail-basis').textContent = '相似依據：' + tags.join('・');

    document.getElementById('dup-detail-new').innerHTML = renderDupEventBlock(item.pending);
    document.getElementById('dup-detail-old').innerHTML = renderDupEventBlock(item.match);
}

window.resolveDup = async function(action) {
    const item = dupCurrentList[dupCurrentIndex];
    const pendingId = item.pending.id;
    const matchId = item.match.id;

    try {
        if (action === 'keep_old') {
            await supabase.from('events').delete().eq('id', pendingId);
        } else if (action === 'replace_with_new') {
            await supabase.from('events').update({
                quote: item.pending.quote,
                context: item.pending.context,
                response_summary: item.pending.response_summary,
                people_impact: item.pending.people_impact,
                people_impact_score: item.pending.people_impact_score,
                national_security_impact: item.pending.national_security_impact,
                national_impact_score: item.pending.national_impact_score,
                score_reason: item.pending.score_reason || null,
                date: item.pending.date,
                source_url: item.pending.source_url
            }).eq('id', matchId);
            await supabase.from('events').delete().eq('id', pendingId);
        } else if (action === 'keep_both') {
            const [a, b] = [pendingId, matchId].sort();
            await supabase.from('duplicate_ignore_pairs').insert({ event_id_a: a, event_id_b: b });
        } else if (action === 'flag_later') {
            await supabase.from('events').update({ flagged_for_review: true }).eq('id', pendingId);
        }
    } catch (err) {
        alert('處理失敗：' + err.message);
        return;
    }

    dupCurrentList.splice(dupCurrentIndex, 1);
    dupResults[dupCurrentTier] = dupCurrentList;

    if (dupCurrentList.length === 0) {
        await fetchAndRenderReviewFeed();
        backToDupList();
        showDupList(dupCurrentTier);
        return;
    }

    if (dupCurrentIndex >= dupCurrentList.length) {
        dupCurrentIndex = dupCurrentList.length - 1;
    }
    await fetchAndRenderReviewFeed();
    renderCurrentDupDetail();
};



// ===== 站長觀點管理 =====
let takeChosenEvents = [];
let editingTakeId = null; // null = 新增模式；有值 = 正在編輯這篇既有的站長觀點

async function initEditorTakesTab() {
    document.getElementById('take-title').value = '';
    document.getElementById('take-content').value = '';
    document.getElementById('take-new-politician-name').value = '';
    document.getElementById('take-event-search').value = '';
    takeChosenEvents = [];
    editingTakeId = null;
    resetEditorTakeFormUI();

    renderTakePoliticianCheckboxes();

    if (cacheEventsForAnalysis.length === 0) {
        const { data } = await supabase.from('events').select('id, quote, date').order('date', { ascending: false });
        cacheEventsForAnalysis = data || [];
    }
    renderTakeEventOptions(cacheEventsForAnalysis);
    renderTakeEventChips();

    await refreshEditorTakesList();
}

function renderTakePoliticianCheckboxes() {
    const box = document.getElementById('take-politicians-checkboxes');
    box.innerHTML = cachePoliticians.map(p => `
        <label class="checkbox-label">
            <input type="checkbox" name="take-pol-box" value="${p.id}"> ${p.name}${p.is_verified === false ? ' (待查證)' : ''}
        </label>
    `).join('');
}

function resetEditorTakeFormUI() {
    document.getElementById('editor-take-form-heading').textContent = '🗣️ 新增站長觀點';
    document.getElementById('btn-save-editor-take').textContent = '🚀 發布站長觀點';
    document.getElementById('btn-cancel-edit-take').style.display = 'none';
}

window.addNewPoliticianForTake = async function() {
    const nameInput = document.getElementById('take-new-politician-name');
    const name = nameInput.value.trim();
    if (!name) { alert('請輸入人物姓名！'); return; }
    if (cachePoliticians.some(p => p.name === name)) {
        alert('這個姓名已經在人物清單中了，請直接勾選。');
        nameInput.value = '';
        return;
    }

    const { data, error } = await supabase.from('politicians')
        .insert([{ name, is_visible: false, is_verified: false }])
        .select()
        .single();

    if (error) { alert('新增人物失敗：' + error.message); return; }

    cachePoliticians.push(data);
    cachePoliticians.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    renderTakePoliticianCheckboxes();
    const box = document.getElementById('take-politicians-checkboxes');
    const cb = box.querySelector(`input[value="${data.id}"]`);
    if (cb) cb.checked = true;

    nameInput.value = '';
    alert(`已加入「${name}」，標記為「待查證」，暫不會出現在前台人物清單中，待研究員角色查證補齊資料後可於「匯入與基本設定」調整為公開。`);
};

function renderTakeEventOptions(list) {
    const sel = document.getElementById('take-event-select');
    sel.innerHTML = '<option value="">請選擇事件</option>' +
        list.map(e => `<option value="${e.id}">「${(e.quote || '未命名事件').slice(0, 30)}」（${e.date || '無日期'}）</option>`).join('');
}

window.filterTakeEventSelect = function() {
    const term = document.getElementById('take-event-search').value.trim().toLowerCase();
    const filtered = term ? cacheEventsForAnalysis.filter(e => (e.quote || '').toLowerCase().includes(term)) : cacheEventsForAnalysis;
    renderTakeEventOptions(filtered);
};

window.addEventChipForTake = function() {
    const sel = document.getElementById('take-event-select');
    const evId = sel.value;
    if (!evId) { alert('請先選擇事件！'); return; }
    if (takeChosenEvents.some(e => e.id === evId)) { alert('這則事件已經加入清單了。'); return; }
    const ev = cacheEventsForAnalysis.find(e => e.id === evId);
    if (ev) takeChosenEvents.push(ev);
    renderTakeEventChips();
};

window.removeTakeEventChip = function(evId) {
    takeChosenEvents = takeChosenEvents.filter(e => e.id !== evId);
    renderTakeEventChips();
};

function renderTakeEventChips() {
    const box = document.getElementById('take-events-chosen');
    box.innerHTML = takeChosenEvents.length > 0 ? takeChosenEvents.map(e => `
        <span class="checkbox-label" style="background:#ede9fe; padding:4px 8px; border-radius:12px;">
            📌 「${(e.quote || '').slice(0, 20)}」
            <button type="button" style="border:none;background:none;color:#dc2626;cursor:pointer;font-weight:bold;" onclick="removeTakeEventChip('${e.id}')">✕</button>
        </span>
    `).join('') : '<span style="color:var(--text-muted); font-size:0.85rem;">尚未關聯任何既有事件</span>';
}

window.saveEditorTake = async function() {
    const title = document.getElementById('take-title').value.trim();
    const content = document.getElementById('take-content').value.trim();
    const checkedPolIds = Array.from(document.querySelectorAll('input[name="take-pol-box"]:checked')).map(cb => cb.value);

    if (!title) { alert('請輸入標題！'); return; }
    if (!content) { alert('請輸入內容！'); return; }

    if (editingTakeId) {
        // 編輯既有站長觀點：更新主體內容，關聯的人物／事件則用「先清空再重建」
        // 的方式同步，不用一筆筆比對誰加了誰刪了，邏輯簡單也不容易漏掉。
        const takeId = editingTakeId;
        const { error: updateError } = await supabase.from('editor_takes')
            .update({ title, content })
            .eq('id', takeId);
        if (updateError) { alert('更新失敗：' + updateError.message); return; }

        const { error: delPolErr } = await supabase.from('editor_take_politician_map').delete().eq('editor_take_id', takeId);
        if (delPolErr) console.error('清除舊人物關聯失敗:', delPolErr);
        const { error: delEvErr } = await supabase.from('editor_take_event_map').delete().eq('editor_take_id', takeId);
        if (delEvErr) console.error('清除舊事件關聯失敗:', delEvErr);

        if (checkedPolIds.length > 0) {
            const { error: polMapError } = await supabase.from('editor_take_politician_map')
                .insert(checkedPolIds.map(pid => ({ editor_take_id: takeId, politician_id: pid })));
            if (polMapError) console.error('關聯政治人物失敗:', polMapError);
        }
        if (takeChosenEvents.length > 0) {
            const { error: evMapError } = await supabase.from('editor_take_event_map')
                .insert(takeChosenEvents.map(e => ({ editor_take_id: takeId, event_id: e.id })));
            if (evMapError) console.error('關聯事件失敗:', evMapError);
        }

        alert('站長觀點已更新！');
        await initEditorTakesTab();
        return;
    }

    const { data: takeData, error: takeError } = await supabase.from('editor_takes')
        .insert([{ title, content, is_visible: true }])
        .select()
        .single();

    if (takeError) { alert('發布失敗：' + takeError.message); return; }

    const takeId = takeData.id;

    if (checkedPolIds.length > 0) {
        const { error: polMapError } = await supabase.from('editor_take_politician_map')
            .insert(checkedPolIds.map(pid => ({ editor_take_id: takeId, politician_id: pid })));
        if (polMapError) console.error('關聯政治人物失敗:', polMapError);
    }

    if (takeChosenEvents.length > 0) {
        const { error: evMapError } = await supabase.from('editor_take_event_map')
            .insert(takeChosenEvents.map(e => ({ editor_take_id: takeId, event_id: e.id })));
        if (evMapError) console.error('關聯事件失敗:', evMapError);
    }

    alert('站長觀點已發布！');
    await initEditorTakesTab();
};

window.editEditorTake = async function(id) {
    const { data, error } = await supabase.from('editor_takes')
        .select(`
            id, title, content,
            editor_take_politician_map ( politician_id ),
            editor_take_event_map ( event_id, events ( quote, date ) )
        `)
        .eq('id', id)
        .single();

    if (error || !data) { alert('讀取這篇站長觀點失敗，請稍後再試。'); return; }

    editingTakeId = id;
    document.getElementById('take-title').value = data.title || '';
    document.getElementById('take-content').value = data.content || '';

    renderTakePoliticianCheckboxes();
    const checkedIds = new Set((data.editor_take_politician_map || []).map(m => m.politician_id));
    document.querySelectorAll('input[name="take-pol-box"]').forEach(cb => {
        cb.checked = checkedIds.has(cb.value);
    });

    takeChosenEvents = (data.editor_take_event_map || [])
        .filter(m => m.event_id)
        .map(m => ({ id: m.event_id, quote: m.events?.quote || '', date: m.events?.date || '' }));
    renderTakeEventChips();

    document.getElementById('editor-take-form-heading').textContent = `✏️ 編輯站長觀點：${data.title || ''}`;
    document.getElementById('btn-save-editor-take').textContent = '💾 更新此觀點';
    document.getElementById('btn-cancel-edit-take').style.display = 'inline-flex';

    document.getElementById('take-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.cancelEditEditorTake = function() {
    editingTakeId = null;
    document.getElementById('take-title').value = '';
    document.getElementById('take-content').value = '';
    takeChosenEvents = [];
    renderTakePoliticianCheckboxes();
    renderTakeEventChips();
    resetEditorTakeFormUI();
};

/* ============================================================
   讀者意見反應（純匿名，讀者端只能新增，這裡才看得到）
   ============================================================ */
async function initFeedbackTab() {
    await refreshFeedbackList();
}

window.setFeedbackFilter = function(filterType) {
    currentFeedbackFilter = filterType;
    document.getElementById('feedback-filter-btn-unread').classList.toggle('active', filterType === 'unread');
    document.getElementById('feedback-filter-btn-all').classList.toggle('active', filterType === 'all');
    refreshFeedbackList();
};

async function refreshFeedbackList() {
    const listEl = document.getElementById('list-feedback');
    if (!listEl || !supabase) return;
    listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:1rem;">載入中...</div>';

    let query = supabase.from('feedback_submissions').select('*').order('created_at', { ascending: false });
    if (currentFeedbackFilter === 'unread') query = query.eq('is_read', false);

    const { data, error } = await query;
    if (error) {
        listEl.innerHTML = `<div style="text-align:center; color:var(--danger); padding:1rem;">載入失敗：${error.message}</div>`;
        return;
    }

    if (!data || data.length === 0) {
        listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:1rem;">目前沒有符合條件的意見反應</div>';
        return;
    }

    listEl.innerHTML = data.map(f => `
        <div class="item-row" style="align-items:flex-start;">
            <div class="item-row-left" style="flex:1;">
                <span class="item-sub">${new Date(f.created_at).toLocaleString('zh-TW')}${f.is_read ? '' : '　<strong style="color:var(--accent);">● 未讀</strong>'}</span>
                <span class="item-title" style="font-weight:400; white-space:pre-wrap;">${(f.content || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
            </div>
            <div style="display:flex; gap:6px; flex-shrink:0;">
                ${f.is_read ? '' : `<button class="btn btn-secondary" style="padding:4px 10px;" onclick="markFeedbackRead('${f.id}')">標為已讀</button>`}
                <button class="btn btn-danger" style="padding:4px 10px;" onclick="deleteFeedback('${f.id}')">🗑️</button>
            </div>
        </div>
    `).join('');
}

window.markFeedbackRead = async function(id) {
    const { error } = await supabase.from('feedback_submissions').update({ is_read: true }).eq('id', id);
    if (error) { alert('更新失敗：' + error.message); return; }
    await refreshFeedbackList();
};

window.deleteFeedback = async function(id) {
    if (!confirm('確定要刪除這則意見反應嗎？此動作無法復原。')) return;
    const { error } = await supabase.from('feedback_submissions').delete().eq('id', id);
    if (error) { alert('刪除失敗：' + error.message); return; }
    await refreshFeedbackList();
};

async function refreshEditorTakesList() {
    const listEl = document.getElementById('list-editor-takes');
    const { data, error } = await supabase.from('editor_takes')
        .select(`
            id, title, content, is_visible, created_at,
            editor_take_politician_map ( politicians ( name ) ),
            editor_take_event_map ( events ( quote ) )
        `)
        .order('created_at', { ascending: false });

    if (error) { listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:1rem;">載入失敗</div>'; return; }

    listEl.innerHTML = (data && data.length > 0) ? data.map(t => {
        const pols = (t.editor_take_politician_map || []).map(m => m.politicians?.name).filter(Boolean).join('、');
        return `
        <div class="item-row">
            <div class="item-row-left">
                <span class="item-title">${t.is_visible ? '' : '🙈 [已隱藏] '}${t.title}</span>
                <span class="item-sub">${pols ? '關聯人物：' + pols + '　' : ''}${(t.content || '').slice(0, 40)}...</span>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="btn" style="padding:4px 10px; background:var(--warning);" onclick="editEditorTake('${t.id}')">✏️ 編輯</button>
                <button class="btn btn-secondary" style="padding:4px 10px;" onclick="toggleEditorTakeVisibility('${t.id}', ${t.is_visible})">${t.is_visible ? '隱藏' : '恢復顯示'}</button>
                <button class="btn btn-danger" style="padding:4px 10px;" onclick="deleteEditorTake('${t.id}')">🗑️</button>
            </div>
        </div>`;
    }).join('') : '<div style="text-align:center; color:var(--text-muted); padding:1rem;">尚無站長觀點</div>';
}

window.toggleEditorTakeVisibility = async function(id, currentVisible) {
    const { error } = await supabase.from('editor_takes').update({ is_visible: !currentVisible }).eq('id', id);
    if (error) { alert('更新失敗：' + error.message); return; }
    await refreshEditorTakesList();
};

window.deleteEditorTake = async function(id) {
    if (!confirm('確定要刪除這篇站長觀點嗎？相關留言也會一併刪除，此動作無法復原。')) return;
    const { error } = await supabase.from('editor_takes').delete().eq('id', id);
    if (error) { alert('刪除失敗：' + error.message); return; }
    if (editingTakeId === id) cancelEditEditorTake();
    await refreshEditorTakesList();
    await refreshTakeCommentsList();
};

async function refreshTakeCommentsList() {
    const listEl = document.getElementById('list-take-comments');
    const { data, error } = await supabase.from('editor_take_comments')
        .select('id, author_name, content, created_at, is_hidden, report_count, editor_takes(title)')
        .order('report_count', { ascending: false })
        .order('created_at', { ascending: false });

    if (error) { listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:1rem;">載入失敗</div>'; return; }

    listEl.innerHTML = (data && data.length > 0) ? data.map(c => `
        <div class="item-row">
            <div class="item-row-left">
                <span class="item-title">${c.is_hidden ? '🙈 [已隱藏] ' : ''}${c.author_name || '匿名讀者'}　${c.report_count > 0 ? `🚩x${c.report_count}` : ''}</span>
                <span class="item-sub">於「${c.editor_takes?.title || '未知文章'}」留言：${(c.content || '').slice(0, 50)}</span>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="btn btn-secondary" style="padding:4px 10px;" onclick="toggleTakeCommentVisibility('${c.id}', ${c.is_hidden})">${c.is_hidden ? '恢復顯示' : '隱藏'}</button>
                <button class="btn btn-danger" style="padding:4px 10px;" onclick="deleteTakeComment('${c.id}')">🗑️</button>
            </div>
        </div>
    `).join('') : '<div style="text-align:center; color:var(--text-muted); padding:1rem;">尚無留言</div>';
}

window.toggleTakeCommentVisibility = async function(id, currentHidden) {
    const { error } = await supabase.from('editor_take_comments').update({ is_hidden: !currentHidden }).eq('id', id);
    if (error) { alert('更新失敗：' + error.message); return; }
    await refreshTakeCommentsList();
};

window.deleteTakeComment = async function(id) {
    if (!confirm('確定要永久刪除這則留言嗎？')) return;
    const { error } = await supabase.from('editor_take_comments').delete().eq('id', id);
    if (error) { alert('刪除失敗：' + error.message); return; }
    await refreshTakeCommentsList();
};

/* ============================================================
   重大事件：跟人物言行的爭議事件資料庫完全分開的獨立內容
   ============================================================ */
async function initMajorEventsTab() {
    document.getElementById('major-event-title').value = '';
    document.getElementById('major-event-summary').value = '';
    document.getElementById('major-event-content').value = '';
    document.getElementById('major-event-new-source-media').value = '';
    document.getElementById('major-event-new-source-url').value = '';
    majorEventSources = [];
    editingMajorEventId = null;
    renderMajorEventSourceRows();
    resetMajorEventFormUI();
    await refreshMajorEventsList();
}

function resetMajorEventFormUI() {
    document.getElementById('major-event-form-heading').textContent = '🗞️ 新增重大事件';
    document.getElementById('btn-save-major-event').textContent = '🚀 發布重大事件';
    document.getElementById('btn-cancel-edit-major-event').style.display = 'none';
}

function renderMajorEventSourceRows() {
    const box = document.getElementById('major-event-sources-list');
    if (majorEventSources.length === 0) {
        box.innerHTML = '<div style="color:var(--text-muted); font-size:0.85rem;">尚未加入任何來源連結</div>';
        return;
    }
    box.innerHTML = majorEventSources.map((s, idx) => `
        <div class="item-row">
            <div class="item-row-left">
                <span class="item-title">${s.media_name ? s.media_name : '（未填媒體名稱）'}</span>
                <span class="item-sub">${s.url}</span>
            </div>
            <button class="btn btn-danger" style="padding:4px 8px; font-size:0.8rem;" onclick="removeMajorEventSourceRow(${idx})">刪除</button>
        </div>
    `).join('');
}

window.addMajorEventSourceRow = function() {
    const mediaEl = document.getElementById('major-event-new-source-media');
    const urlEl = document.getElementById('major-event-new-source-url');
    const url = urlEl.value.trim();
    if (!url) { alert('請輸入來源連結網址！'); return; }
    majorEventSources.push({ media_name: mediaEl.value.trim(), url });
    mediaEl.value = '';
    urlEl.value = '';
    renderMajorEventSourceRows();
};

window.removeMajorEventSourceRow = function(idx) {
    majorEventSources.splice(idx, 1);
    renderMajorEventSourceRows();
};

window.saveMajorEvent = async function() {
    const title = document.getElementById('major-event-title').value.trim();
    const summary = document.getElementById('major-event-summary').value.trim();
    const content = document.getElementById('major-event-content').value.trim();

    if (!title) { alert('請輸入標題！'); return; }
    if (!content) { alert('請輸入全文內容！'); return; }

    if (editingMajorEventId) {
        const eventId = editingMajorEventId;
        const { error: updateError } = await supabase.from('major_events')
            .update({ title, summary, content })
            .eq('id', eventId);
        if (updateError) { alert('更新失敗：' + updateError.message); return; }

        // 來源連結一樣用「先清空再重建」，不用一筆筆比對誰加了誰刪了
        const { error: delErr } = await supabase.from('major_event_sources').delete().eq('major_event_id', eventId);
        if (delErr) console.error('清除舊來源連結失敗:', delErr);

        if (majorEventSources.length > 0) {
            const { error: srcError } = await supabase.from('major_event_sources')
                .insert(majorEventSources.map(s => ({ major_event_id: eventId, media_name: s.media_name || null, url: s.url })));
            if (srcError) console.error('寫入來源連結失敗:', srcError);
        }

        alert('重大事件已更新！');
        await initMajorEventsTab();
        return;
    }

    const { data: eventData, error: insertError } = await supabase.from('major_events')
        .insert([{ title, summary, content, is_visible: true }])
        .select()
        .single();

    if (insertError) { alert('發布失敗：' + insertError.message); return; }

    const eventId = eventData.id;

    if (majorEventSources.length > 0) {
        const { error: srcError } = await supabase.from('major_event_sources')
            .insert(majorEventSources.map(s => ({ major_event_id: eventId, media_name: s.media_name || null, url: s.url })));
        if (srcError) console.error('寫入來源連結失敗:', srcError);
    }

    alert('重大事件已發布！');
    await initMajorEventsTab();
};

window.editMajorEvent = async function(id) {
    const { data, error } = await supabase.from('major_events')
        .select('id, title, summary, content, major_event_sources ( media_name, url )')
        .eq('id', id)
        .single();

    if (error || !data) { alert('讀取這篇重大事件失敗，請稍後再試。'); return; }

    editingMajorEventId = id;
    document.getElementById('major-event-title').value = data.title || '';
    document.getElementById('major-event-summary').value = data.summary || '';
    document.getElementById('major-event-content').value = data.content || '';

    majorEventSources = (data.major_event_sources || []).map(s => ({ media_name: s.media_name || '', url: s.url }));
    renderMajorEventSourceRows();

    document.getElementById('major-event-form-heading').textContent = `✏️ 編輯重大事件：${data.title || ''}`;
    document.getElementById('btn-save-major-event').textContent = '💾 更新此篇重大事件';
    document.getElementById('btn-cancel-edit-major-event').style.display = 'inline-flex';

    document.getElementById('major-event-title').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.cancelEditMajorEvent = function() {
    editingMajorEventId = null;
    document.getElementById('major-event-title').value = '';
    document.getElementById('major-event-summary').value = '';
    document.getElementById('major-event-content').value = '';
    majorEventSources = [];
    renderMajorEventSourceRows();
    resetMajorEventFormUI();
};

async function refreshMajorEventsList() {
    const listEl = document.getElementById('list-major-events');
    if (!listEl || !supabase) return;
    listEl.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:1rem;">載入中...</div>';

    const { data, error } = await supabase.from('major_events')
        .select('id, title, is_visible, created_at')
        .order('created_at', { ascending: false });

    if (error) {
        listEl.innerHTML = `<div style="text-align:center; color:var(--danger); padding:1rem;">載入失敗：${error.message}</div>`;
        return;
    }

    listEl.innerHTML = (data && data.length > 0) ? data.map(ev => `
        <div class="item-row">
            <div class="item-row-left">
                <span class="item-title">${ev.title}</span>
                <span class="item-sub">${new Date(ev.created_at).toLocaleDateString('zh-TW')}${ev.is_visible ? '' : '　<strong style="color:var(--text-muted);">（已隱藏）</strong>'}</span>
            </div>
            <div style="display:flex; gap:6px;">
                <button class="btn" style="padding:4px 10px; background:var(--warning);" onclick="editMajorEvent('${ev.id}')">✏️ 編輯</button>
                <button class="btn btn-secondary" style="padding:4px 10px;" onclick="toggleMajorEventVisibility('${ev.id}', ${ev.is_visible})">${ev.is_visible ? '隱藏' : '恢復顯示'}</button>
                <button class="btn btn-danger" style="padding:4px 10px;" onclick="deleteMajorEvent('${ev.id}')">🗑️</button>
            </div>
        </div>
    `).join('') : '<div style="text-align:center; color:var(--text-muted); padding:1rem;">尚無重大事件</div>';
}

window.toggleMajorEventVisibility = async function(id, currentVisible) {
    const { error } = await supabase.from('major_events').update({ is_visible: !currentVisible }).eq('id', id);
    if (error) { alert('更新失敗：' + error.message); return; }
    await refreshMajorEventsList();
};

window.deleteMajorEvent = async function(id) {
    if (!confirm('確定要刪除這篇重大事件嗎？相關的來源連結也會一併刪除，此動作無法復原。')) return;
    const { error } = await supabase.from('major_events').delete().eq('id', id);
    if (error) { alert('刪除失敗：' + error.message); return; }
    if (editingMajorEventId === id) cancelEditMajorEvent();
    await refreshMajorEventsList();
};
