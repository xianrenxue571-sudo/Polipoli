import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

let currentTab = 'politicians';
let currentMode = 'latest'; 
let currentFilterId = null; 
let currentTargetName = null;

let page = 0];
const PAGE_SIZE = 15;
let isFetching = false;
let hasMoreData = true;

let cachePoliticians = [];
let cacheIssues = [];
let topFivePoliticians = [];

const quickPolTags = ['游錫堃', '鄺麗貞', '傅崐萁', '陳玉珍', '徐欣瑩', '張嘉郡', '陳智菡', '黃瀞瑩', '顏寬恒', '佀廣洋'];

const FUZZY_DICT = {
    "雞蛋": "食安", "進口蛋": "食安", "巴西蛋": "食安", "萊豬": "食安", "美豬": "食安",
    "核電": "能源", "綠能": "能源", "光電": "能源", "斷電": "能源", "停電": "能源", "缺電": "能源",
    "居住": "居住正義", "房價": "居住正義", "社會住宅": "居住正義", "社宅": "居住正義", "囤房稅": "居住正義",
    "新竹棒球場": "公共工程", "棒球場": "公共工程", "公共工程": "公共工程", "豆腐渣": "公共工程",
    "勞工": "勞工權益", "勞基法": "勞工權益", "一例一休": "勞工權益", "過勞": "勞工權益",
    "幼兒園": "婦幼", "托育": "婦幼", "性騷": "性別平權", "MeToo": "性別平權", "同婚": "性別平權",
    "詐騙": "司法治安", "黑金": "司法治安", "黑道": "司法治安", "外役監": "司法治安", "槍擊": "司法治安",
    "國會改革": "國會爭議", "藐視國會": "國會爭議", "立院衝突": "國會爭議",
    "反滲透法": "國家安全", "間諜": "國家安全", "共諜": "國家安全", "國防": "國家安全",
    "疫苗": "醫療衛生", "快篩": "醫療衛生", "口罩": "醫療衛生",
    "台美": "外交國際", "訪台": "外交國際", "兩岸": "兩岸關係", "九二共識": "兩岸關係"
};

const RARE_WORDS = ["佀", "堃", "崐", "貞", "菡", "瑩", "寬", "恒", "珍"];

const feedContainer = document.getElementById('events-feed');
const feedTitle = document.getElementById('feed-title');
const loader = document.getElementById('loader');
const endMessage = document.querySelector('.end-message');

// --- 點讚功能：UUID 與 狀態暫存 ---
function getUserUUID() {
    let uuid = localStorage.getItem('polipoli_user_uuid');
    if (!uuid) {
        uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
        localStorage.setItem('polipoli_user_uuid', uuid);
    }
    return uuid;
}
const userUUID = getUserUUID();
let userLikedEventIds = new Set();

async function fetchUserLikes() {
    try {
        const { data } = await supabase.from('event_likes').select('event_id').eq('user_uuid', userUUID);
        if (data) {
            userLikedEventIds = new Set(data.map(item => item.event_id));
        }
    } catch(e) { console.error('讀取按讚紀錄失敗', e); }
}

async function init() {
    await fetchUserLikes();
    setupHeaderScroll();
    setupTabListeners();
    setupIntersectionObserver();
    
    await Promise.all([fetchSidebarData(), fetchTopFive()]);
    renderSidebar();
    loadLatestEvents();
}

function setupHeaderScroll() {
    let lastScrollTop = 0;
    const header = document.querySelector('header');
    window.addEventListener('scroll', () => {
        let scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        if (scrollTop > lastScrollTop && scrollTop > 60) {
            header.classList.add('hidden');
        } else {
            header.classList.remove('hidden');
        }
        lastScrollTop = scrollTop <= 0 ? 0 : scrollTop;
    }, { passive: true });
}

async function fetchTopFive() {
    try {
        const { data, error } = await supabase.rpc('get_top_politicians');
        if (error) throw error;
        topFivePoliticians = data || [];
    } catch (err) {
        console.error('撈取熱門排行榜失敗:', err);
    }
}

async function fetchSidebarData() {
    try {
        const [polRes, issRes] = await Promise.all([
            supabase.from('politicians').select('id, name, party').eq('is_visible', true),
            supabase.from('issues').select('id, name')
        ]);
        if (polRes.error) throw polRes.error;
        if (issRes.error) throw issRes.error;
        cachePoliticians = polRes.data || [];
        cacheIssues = issRes.data || [];
    } catch (err) {
        console.error('初始化側邊欄資料失敗:', err);
    }
}

function setupTabListeners() {
    document.getElementById('tab-politicians').addEventListener('click', () => switchMainTab('politicians'));
    document.getElementById('tab-issues').addEventListener('click', () => switchMainTab('issues'));
}

window.switchMainTab = function(tab) {
    if (currentTab === tab) return;
    currentTab = tab;
    
    document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    
    const sidebarTitle = document.getElementById('sidebar-title');
    const searchInput = document.getElementById('sidebar-search');
    const searchContainer = document.getElementById('sidebar-search-container');
    const mobileSelect = document.getElementById('mobile-issue-select');
    
    if (tab === 'politicians') {
        sidebarTitle.textContent = '人物檔案庫';
        searchInput.placeholder = '輸入姓名搜尋人物...';
        searchContainer.style.display = 'block';
        mobileSelect.style.display = 'none';
    } else {
        sidebarTitle.textContent = '社會議題庫';
        searchContainer.style.display = 'none';
        mobileSelect.style.display = 'block';
    }
    
    resetToLatest(true);
};

window.filterSidebar = function() {
    renderSidebar();
};

function renderSidebar() {
    const listContainer = document.querySelector('.sidebar-list');
    const searchInput = document.getElementById('sidebar-search');
    const mobileSelect = document.getElementById('mobile-issue-select');
    
    if (currentTab === 'politicians') {
        const keyword = searchInput ? searchInput.value.trim() : '';
        let filtered = cachePoliticians;
        if (keyword) {
            filtered = cachePoliticians.filter(p => p.name.includes(keyword) || (p.party && p.party.includes(keyword)));
        }
        
        let html = '';
        if (keyword === '') {
            html += `
                <div class="ranking-box">
                    <h3 class="ranking-title">🔥 熱門監督排行 (前五名)</h3>
                    <ol class="ranking-list">
                        ${topFivePoliticians.map((p, idx) => `
                            <li class="ranking-item" onclick="filterByPolitician('${p.politician_name}')">
                                <span class="ranking-num rank-${idx+1}">${idx+1}</span>
                                <span class="ranking-name">${p.politician_name}</span>
                                <span class="ranking-party">(${p.politician_party || '無黨籍'})</span>
                                <span class="ranking-count">${p.event_count} 筆事件</span>
                            </li>
                        `).join('')}
                    </ol>
                </div>
            `;
            
            html += `<h3 style="font-size:1rem; margin:1rem 0 0.5rem 0; color:var(--text-muted);">🔤 難檢字快速捷徑</h3>`;
            html += `<div class="quick-tags-container">`;
            quickPolTags.forEach(tag => {
                const isActive = (currentMode === 'politician' && currentTargetName === tag) ? 'active' : '';
                html += `<button class="quick-tag-btn ${isActive}" onclick="filterByPolitician('${tag}')">${tag}</button>`;
            });
            html += `</div>`;
        }
        
        html += `<h3 style="font-size:1rem; margin:1.5rem 0 0.5rem 0; color:var(--text-muted);">${keyword ? '🔍 搜尋結果' : '👤 所有政治人物'}</h3>`;
        if (filtered.length === 0) {
            html += `<div style="color:var(--text-muted); padding:1rem; text-align:center;">找不到符合的人物</div>`;
        } else {
            html += `<div class="pol-grid">`;
            filtered.forEach(p => {
                const isActive = (currentMode === 'politician' && currentTargetName === p.name) ? 'active' : '';
                html += `<button class="sidebar-item-btn ${isActive}" onclick="filterByPolitician('${p.name}')">${p.name} <span style="font-size:0.8rem; opacity:0.7;">(${p.party || '無'})</span></button>`;
            });
            html += `</div>`;
        }
        listContainer.innerHTML = html;
        mobileSelect.style.display = 'none';
        
    } else {
        let optionsHtml = '<option value="">-- 請選擇社會議題 --</option>';
        let listHtml = '<div class="issue-list">';
        
        cacheIssues.forEach(iss => {
            const isSelected = (currentMode === 'issue' && currentFilterId === iss.id) ? 'selected' : '';
            const isActive = (currentMode === 'issue' && currentFilterId === iss.id) ? 'active' : '';
            optionsHtml += `<option value="${iss.id}" ${isSelected}>📌 ${iss.name}</option>`;
            listHtml += `<button class="sidebar-item-btn ${isActive}" onclick="filterByIssue('${iss.id}', '${iss.name}')">📌 ${iss.name}</button>`;
        });
        
        listHtml += '</div>';
        listContainer.innerHTML = listHtml;
        mobileSelect.innerHTML = optionsHtml;
        mobileSelect.style.display = 'block';
    }
}

window.handleMobileIssueSelect = function(val) {
    if (!val) {
        resetToLatest();
        return;
    }
    const found = cacheIssues.find(i => i.id === val);
    if (found) filterByIssue(found.id, found.name);
};

window.filterByPolitician = function(name) {
    currentMode = 'politician';
    currentTargetName = name;
    currentFilterId = null;
    page = 0;
    hasMoreData = true;
    feedContainer.innerHTML = '';
    feedTitle.textContent = `👤 ${name} 的言行失言全紀錄`;
    endMessage.style.display = 'none';
    
    // 同步歷史狀態路徑網址
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + `?politician=${encodeURIComponent(name)}`;
    window.history.pushState({path:newUrl}, '', newUrl);
    document.title = `【${name}】雙標失言與爭議言行懶人包 - Polipoli 啪哩啪哩`;

    renderSidebar();
    loadPoliticianEvents();
};

window.filterByIssue = function(id, name) {
    currentMode = 'issue';
    currentFilterId = id;
    currentTargetName = name;
    page = 0;
    hasMoreData = true;
    feedContainer.innerHTML = '';
    feedTitle.textContent = `📌 【${name}】議題相關爭議事件牆`;
    endMessage.style.display = 'none';
    
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + `?issue=${encodeURIComponent(id)}`;
    window.history.pushState({path:newUrl}, '', newUrl);
    document.title = `【${name}】相關重大政治爭議與失言事件簿 - Polipoli 啪哩啪哩`;

    renderSidebar();
    loadIssueEvents();
};

async function loadLatestEvents() {
    if (isFetching || !hasMoreData) return;
    isFetching = true;
    loader.classList.add('visible');
    
    try {
        const keyword = document.getElementById('sidebar-search').value.trim();
        let query = supabase.from('events')
            .select('id, quote, context, source_url, date, category, influence, importance, likes_count, parent_event_id, alternative_scenario')
            .eq('is_visible', true)
            .order('date', { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
            
        if (keyword) {
            query = query.or(`quote.ilike.%${keyword}%,context.ilike.%${keyword}%,category.ilike.%${keyword}%`);
        }
        
        const { data, error } = await query;
        if (error) throw error;
        
        if (!data || data.length < PAGE_SIZE) {
            hasMoreData = false;
        }
        
        if (data && data.length > 0) {
            await renderEvents(data);
            page++;
        }
        
        if (!hasMoreData && page > 0) {
            loader.classList.remove('visible');
            endMessage.style.display = 'block';
        } else if (data && data.length === 0 && page === 0) {
            loader.classList.remove('visible');
            feedContainer.innerHTML = '<div style="text-align:center; padding: 3rem; color: #6b7280; font-weight: bold;">目前尚無相關公開事件。</div>';
        }
    } catch (err) {
        console.error(err);
    } finally {
        isFetching = false;
        loader.classList.remove('visible');
    }
}

async function loadPoliticianEvents() {
    if (isFetching || !hasMoreData) return;
    isFetching = true;
    loader.classList.add('visible');
    
    try {
        const { data: mapData, error: mapErr } = await supabase.from('event_politician_map')
            .select('event_id')
            .innerJoin('politicians', 'politician_id', 'id')
            .eq('politicians.name', currentTargetName);
            
        if (mapErr) throw mapErr;
        
        if (!mapData || mapData.length === 0) {
            hasMoreData = false;
            feedContainer.innerHTML = `<div style="text-align:center; padding: 3rem; color: #6b7280; font-weight: bold;">目前尚未收錄 ${currentTargetName} 的不良言行事件。</div>`;
            return;
        }
        
        const eIds = mapData.map(m => m.event_id);
        
        const { data, error } = await supabase.from('events')
            .select('id, quote, context, source_url, date, category, influence, importance, likes_count, parent_event_id, alternative_scenario')
            .eq('is_visible', true)
            .in('id', eIds)
            .order('date', { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
            
        if (error) throw error;
        
        if (!data || data.length < PAGE_SIZE) {
            hasMoreData = false;
        }
        
        if (data && data.length > 0) {
            await renderEvents(data);
            page++;
        }
        
        if (!hasMoreData && page > 0) {
            loader.classList.remove('visible');
            endMessage.style.display = 'block';
        }
    } catch (err) {
        console.error(err);
    } finally {
        isFetching = false;
        loader.classList.remove('visible');
    }
}

async function loadIssueEvents() {
    if (isFetching || !hasMoreData) return;
    isFetching = true;
    loader.classList.add('visible');
    
    try {
        const { data: mapData, error: mapErr } = await supabase.from('event_issue_map')
            .select('event_id')
            .eq('issue_id', currentFilterId);
            
        if (mapErr) throw mapErr;
        
        if (!mapData || mapData.length === 0) {
            hasMoreData = false;
            feedContainer.innerHTML = `<div style="text-align:center; padding: 3rem; color: #6b7280; font-weight: bold;">目前尚無關聯至【${currentTargetName}】的議題事件。</div>`;
            return;
        }
        
        const eIds = mapData.map(m => m.event_id);
        
        const { data, error } = await supabase.from('events')
            .select('id, quote, context, source_url, date, category, influence, importance, likes_count, parent_event_id, alternative_scenario')
            .eq('is_visible', true)
            .in('id', eIds)
            .order('date', { ascending: false })
            .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
            
        if (error) throw error;
        
        if (!data || data.length < PAGE_SIZE) {
            hasMoreData = false;
        }
        
        if (data && data.length > 0) {
            await renderEvents(data);
            page++;
        }
        
        if (!hasMoreData && page > 0) {
            loader.classList.remove('visible');
            endMessage.style.display = 'block';
        }
    } catch (err) {
        console.error(err);
    } finally {
        isFetching = false;
        loader.classList.remove('visible');
    }
}

async function renderEvents(events) {
    const parentEvents = events.filter(e => !e.parent_event_id);
    const childEvents = events.filter(e => e.parent_event_id);

    const eventIds = parentEvents.map(e => e.id);
    if (eventIds.length === 0) return;

    let polMap = {};
    let issMap = {};

    try {
        const [polMapped, issMapped] = await Promise.all([
            supabase.from('event_politician_map').select('event_id, politicians(name, party)').in('event_id', eventIds),
            supabase.from('event_issue_map').select('event_id, issues(name)').in('event_id', eventIds)
        ]);

        if (polMapped.data) {
            polMapped.data.forEach(item => {
                if (!polMap[item.event_id]) polMap[item.event_id] = [];
                if (item.politicians) polMap[item.event_id].push(item.politicians);
            });
        }
        if (issMapped.data) {
            issMapped.data.forEach(item => {
                if (!issMap[item.event_id]) issMap[item.event_id] = [];
                if (item.issues) issMap[item.event_id].push(item.issues);
            });
        }
    } catch (e) {
        console.error('關聯映射載入失敗', e);
    }

    const html = parentEvents.map(event => {
        const associatedPols = polMap[event.id] || [];
        const associatedIssues = issMap[event.id] || [];

        let targetHtml = associatedPols.map(p => 
            `<span class="target-badge" onclick="event.stopPropagation(); filterByPolitician('${p.name}')">👤 ${p.name} <small>(${p.party || '無'})</small></span>`
        ).join(' ');

        let tagsHtml = '';
        if (event.category) {
            tagsHtml += `<span class="meta-tag severity-tag high">⚠️ ${event.category}</span>`;
        }
        associatedIssues.forEach(iss => {
            tagsHtml += `<span class="meta-tag" onclick="event.stopPropagation(); filterByIssue('${iss.id || ''}', '${iss.name}')" style="cursor:pointer;">📌 ${iss.name}</span>`;
        });

        if (event.influence) tagsHtml += `<span class="meta-tag">🔥 討論度 ${event.influence}/5</span>`;
        if (event.importance) tagsHtml += `<span class="meta-tag">📢 嚴重度 ${event.importance}/5</span>`;

        let contentHtml = `<div class="event-quote">「 ${event.quote} 」</div>`;
        if (event.context) {
            contentHtml += `<div class="event-context">${event.context}</div>`;
        }

        const linkedSubEvents = childEvents.filter(c => c.parent_event_id === event.id);
        if (linkedSubEvents.length > 0) {
            contentHtml += `<div class="sub-events-timeline"><h4 style="margin: 0 0 0.5rem 0; color: #9a3412; font-size: 0.95rem;">⚡ 昔日打臉言論對比：</h4>`;
            linkedSubEvents.forEach(sub => {
                contentHtml += `
                    <div class="sub-event-card">
                        <div style="display:flex; justify-content:space-between; font-size:0.85rem; color:#6b7280; margin-bottom:4px;">
                            <span>📅 對比日期：${sub.date || '未知'}</span>
                            <span style="background:#ffedd5; color:#9a3412; padding:1px 6px; border-radius:4px; font-weight:bold;">昔日言論</span>
                        </div>
                        <div style="font-weight:bold; color:#1f2937; margin-bottom:4px;">「 ${sub.quote} 」</div>
                        <div style="font-size:0.95rem; color:#4b5563; background:#ffffff; padding:6px; border-radius:4px; border-left:3px solid #f97316;">${sub.context || ''}</div>
                    </div>
                `;
            });
            contentHtml += `</div>`;
        }

        const sourceHtml = event.source_url ? `<a href="${event.source_url}" target="_blank" class="source-link" rel="noopener noreferrer">🔗 可靠佐證新聞</a>` : '';
        
        const isLiked = userLikedEventIds.has(event.id);
        const likesCount = event.likes_count || 0;
        const likeBtnHtml = `
            <button class="like-btn ${isLiked ? 'liked' : ''}" onclick="toggleLike('${event.id}', this)">
                <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                <span class="like-count">${likesCount}</span>
            </button>
        `;

        return `
            <article class="event-card">
                <div class="card-header">
                    <span class="date-badge">${event.date || '日期未明'}</span>
                    ${targetHtml}
                </div>
                ${contentHtml}
                <div class="tags-container">
                    ${tagsHtml}
                </div>
                <div class="event-actions">
                    <div style="display: flex; gap: 8px; align-items: center; width: 100%; justify-content: flex-end;">
                        ${likeBtnHtml}
                        ${sourceHtml}
                    </div>
                </div>
            </article>
        `;
    }).join('');

    if (events.length === 0 && page === 0) {
        feedContainer.innerHTML = '<div style="text-align:center; padding: 3rem; color: #6b7280; font-weight: bold;">目前尚無相關公開事件。</div>';
    } else {
        feedContainer.insertAdjacentHTML('beforeend', html);
    }
}

// --- 點讚互動邏輯 ---
window.toggleLike = async function(eventId, btnElement) {
    const isCurrentlyLiked = userLikedEventIds.has(eventId);
    const countSpan = btnElement.querySelector('.like-count');
    let currentCount = parseInt(countSpan.textContent) || 0;

    // 1. Optimistic UI 更新 (零延遲體感)
    if (isCurrentlyLiked) {
        userLikedEventIds.delete(eventId);
        btnElement.classList.remove('liked');
        countSpan.textContent = Math.max(0, currentCount - 1);
        
        // 2. 背景發送 API
        const { error } = await supabase.from('event_likes').delete().match({ event_id: eventId, user_uuid: userUUID });
        if (error) {
            // 失敗則回滾
            userLikedEventIds.add(eventId);
            btnElement.classList.add('liked');
            countSpan.textContent = currentCount;
            console.error('收回讚失敗:', error);
        }
    } else {
        userLikedEventIds.add(eventId);
        btnElement.classList.add('liked');
        countSpan.textContent = currentCount + 1;
        
        // 2. 背景發送 API
        const { error } = await supabase.from('event_likes').insert([{ event_id: eventId, user_uuid: userUUID }]);
        if (error) {
            // 失敗則回滾
            userLikedEventIds.delete(eventId);
            btnElement.classList.remove('liked');
            countSpan.textContent = currentCount;
            console.error('按讚失敗:', error);
        }
    }
};

window.resetToLatest = function(force = false) {
    if (!force && currentMode === 'latest' && page === 0) return;
    
    const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
    window.history.pushState({path:newUrl}, '', newUrl);
    document.title = "Polipoli 啪哩啪哩 | 台灣政治人物爭議事件與雙標言行資料庫";

    currentMode = 'latest';
    currentFilterId = null;
    currentTargetName = null;
    page = 0;
    hasMoreData = true;
    document.getElementById('sidebar-search').value = '';
    feedContainer.innerHTML = '';
    
    document.getElementById('stat-dashboard').style.display = 'none';
    
    feedTitle.textContent = currentTab === 'issues' ? '全部社會議題事件' : '綜合最新事件牆';
    endMessage.style.display = 'none';
    
    renderSidebar();
    loadLatestEvents();
};

function setupIntersectionObserver() {
    const options = { root: null, rootMargin: '0px', threshold: 0.1 };
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entries[0].isIntersecting && !isFetching && hasMoreData) {
                if (currentMode === 'latest') loadLatestEvents();
                else if (currentMode === 'politician') loadPoliticianEvents();
                else if (currentMode === 'issue') loadIssueEvents();
            }
        });
    }, options);
    observer.observe(document.getElementById('scroll-anchor'));
}

window.onload = () => {
    const params = new URLSearchParams(window.location.search);
    const polParam = params.get('politician');
    const issParam = params.get('issue');
    
    init().then(() => {
        if (polParam) {
            filterByPolitician(polParam);
        } else if (issParam) {
            const found = cacheIssues.find(i => i.id === issParam);
            if (found) filterByIssue(found.id, found.name);
        }
    });
};
