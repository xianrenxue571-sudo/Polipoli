import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

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

let currentTab = 'politicians';
let currentMode = 'latest'; 
let currentFilterId = null; 
let currentTargetName = null;

let page = 0;
const PAGE_SIZE = 15;
let isFetching = false;
let hasMoreData = true;

let cachePoliticians = [];
let cacheIssues = [];
let topFivePoliticians = [];

const quickPolTags = ['游錫堃', '鄺麗貞', '傅崐萁', '陳玉珍', '徐欣瑩', '張嘉郡', '陳智菡', '黃瀞瑩', '顏寬恒', '佀廣洋'];

const FUZZY_DICT = {
    "雞蛋": "食安", "進口蛋": "食安",
    "圖利": "弊案", "貪污": "弊案",
    "光電": "能源", "跳電": "能源",
    "論文": "學倫", "抄襲": "學倫",
    "黑道": "治安", "詐騙": "治安",
    "違建": "居住正義", "炒房": "居住正義"
};

const feedContainer = document.getElementById('events-feed');
const loader = document.getElementById('loader');
const endMessage = document.getElementById('end-message');
const feedTitle = document.getElementById('feed-title');
const searchContainer = document.getElementById('sidebar-search-container');
const tagsContainer = document.getElementById('quick-tags-container');
const mobileSelect = document.getElementById('mobile-issue-select');

let lastScrollTop = 0;
window.addEventListener('scroll', () => {
    let currentScroll = window.pageYOffset || document.documentElement.scrollTop;
    const header = document.getElementById('main-header');
    if (currentScroll > lastScrollTop && currentScroll > 60) {
        header.classList.add('hidden');
    } else {
        header.classList.remove('hidden');
    }
    lastScrollTop = currentScroll <= 0 ? 0 : currentScroll;
});

window.onload = async () => {
    await fetchUserLikes();
    await fetchSidebarData();
    const urlParams = new URLSearchParams(window.location.search);
    const polId = urlParams.get('pol');
    const issueId = urlParams.get('issue');

    if (polId) {
        const pol = cachePoliticians.find(p => p.id === polId);
        if(pol) {
            currentTab = 'politicians';
            loadSpecificData('politician', pol.id, pol.name, false);
        } else {
            initDefault();
        }
    } else if (issueId) {
        const issue = cacheIssues.find(i => i.id === issueId);
        if(issue) {
            currentTab = 'issues';
            loadSpecificData('issue', issue.id, issue.name, false);
        } else {
            initDefault();
        }
    } else {
        initDefault();
    }
    
    setupIntersectionObserver();
};

function initDefault() {
    renderSidebar();
    loadLatestEvents();
}

async function fetchSidebarData() {
    const [polRes, issueRes, mapRes] = await Promise.all([
        supabase.from('politicians').select('*').eq('is_visible', true).order('name'),
        supabase.from('issues').select('*').eq('is_visible', true).order('name'),
        supabase.from('event_politician_map').select('politician_id')
    ]);
    
    if (polRes.data) cachePoliticians = polRes.data;
    if (issueRes.data) cacheIssues = issueRes.data;

    if (mapRes.data && cachePoliticians.length > 0) {
        const counts = mapRes.data.reduce((acc, cur) => {
            acc[cur.politician_id] = (acc[cur.politician_id] || 0) + 1;
            return acc;
        }, {});
        const topFiveIds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 5);
        topFivePoliticians = cachePoliticians.filter(p => topFiveIds.includes(p.id));
    } else {
        topFivePoliticians = [];
    }
}

window.switchMainTab = function(tabName, preventReload = false) {
    if (currentTab === tabName) return;
    currentTab = tabName;
    
    document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    
    if (!preventReload) {
        resetToLatest(true);
    } else {
        renderSidebar();
    }
};

function renderSidebar() {
    const title = document.getElementById('sidebar-title');
    const searchInput = document.getElementById('sidebar-search');

    if (currentTab === 'politicians') {
        title.textContent = '人物檔案庫';
        searchContainer.style.display = 'block';
        mobileSelect.classList.remove('active-tab');
        tagsContainer.classList.remove('desktop-issue-tags');
        
        if (searchInput.value.trim() !== '') {
            filterSidebar();
        } else {
            renderSidebarButtons();
        }
    } else {
        title.textContent = '社會議題庫';
        searchContainer.style.display = 'none'; 
        mobileSelect.classList.add('active-tab');
        tagsContainer.classList.add('desktop-issue-tags');
        
        renderSidebarButtons(); 
        renderMobileIssueSelect();
    }
}

window.renderMobileIssueSelect = function() {
    let options = `<option value="latest" ${currentMode === 'latest' ? 'selected' : ''}>✨ 全部 / 所有事件</option>`;
    cacheIssues.forEach(i => {
        options += `<option value="${i.id}" ${currentFilterId === i.id ? 'selected' : ''}>📌 ${i.name}</option>`;
    });
    mobileSelect.innerHTML = options;
};

window.handleMobileIssueSelect = function(val) {
    if (val === 'latest') {
        resetToLatest(true);
    } else {
        const issue = cacheIssues.find(i => i.id === val);
        if (issue) loadSpecificData('issue', issue.id, issue.name);
    }
};

function renderSidebarButtons() {
    const isLatestActive = currentMode === 'latest' ? 'active' : '';
    let html = '';
    
    if (currentTab === 'politicians') {
        html += `<button class="quick-tag-btn ${isLatestActive}" style="width: 100%; margin-bottom: 5px; justify-content: center;" onclick="resetToLatest(true)">✨ 綜合最新事件</button>`;
        
        if (topFivePoliticians.length > 0) {
            html += `<div class="section-label">🔥 熱門追蹤人物</div>`;
            html += topFivePoliticians.map(p => {
                const isActive = currentFilterId === p.id ? 'active' : '';
                return `<button class="quick-tag-btn ${isActive}" onclick="loadSpecificData('politician', '${p.id}', '${p.name}')">👤 ${p.name}</button>`;
            }).join('');
        }

        const visibleQuickTags = quickPolTags.filter(tag => cachePoliticians.some(p => p.name === tag));
        const filteredQuickTags = visibleQuickTags.filter(tag => !topFivePoliticians.some(tp => tp.name === tag));

        if (filteredQuickTags.length > 0) {
            html += `<div class="section-label">📌 難檢字快速查</div>`;
            html += filteredQuickTags.map(tag => {
                const p = cachePoliticians.find(pol => pol.name === tag);
                const isActive = currentFilterId === p.id ? 'active' : '';
                return `<button class="quick-tag-btn ${isActive}" onclick="loadSpecificData('politician', '${p.id}', '${p.name}')">${p.name}</button>`;
            }).join('');
        }
    } else {
        html += `<button class="quick-tag-btn ${isLatestActive}" style="width: 100%; margin-bottom: 5px; justify-content: center;" onclick="resetToLatest(true)">✨ 全部 / 所有事件</button>`;
        
        if (cacheIssues.length > 0) {
            html += cacheIssues.map(i => {
                const isActive = currentFilterId === i.id ? 'active' : '';
                return `<button class="quick-tag-btn ${isActive}" onclick="loadSpecificData('issue', '${i.id}', '${i.name}')">📌 ${i.name}</button>`;
            }).join('');
        }
    }
    tagsContainer.innerHTML = html;
}

window.filterSidebar = function() {
    const rawTerm = document.getElementById('sidebar-search').value.trim();
    const term = rawTerm.toLowerCase();
    
    let mappedTerm = term;
    for (const [key, value] of Object.entries(FUZZY_DICT)) {
        if (term.includes(key)) {
            mappedTerm = value;
            break;
        }
    }
    
    if (!term) {
        renderSidebarButtons();
        return;
    }
    
    if (currentTab === 'politicians') {
        const filtered = cachePoliticians.filter(p => p.name.toLowerCase().includes(term));
        if (filtered.length === 0) {
            const isActive = currentFilterId === 'not-found' ? 'active' : '';
            tagsContainer.innerHTML = `<button class="quick-tag-btn ${isActive}" onclick="loadSpecificData('politician', 'not-found', '${rawTerm}')">👤 ${rawTerm}</button>`;
        } else {
            tagsContainer.innerHTML = filtered.map(p => {
                const isActive = currentFilterId === p.id ? 'active' : '';
                return `<button class="quick-tag-btn ${isActive}" onclick="loadSpecificData('politician', '${p.id}', '${p.name}')">👤 ${p.name}</button>`;
            }).join('');
        }
    }
};

function parseContextLinks(text) {
    if (!text) return '無詳細脈絡說明。';
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, '<a href="$1" target="_blank" class="source-link" style="font-size:0.9em; background:none; border:none; padding:0;">🔗 參考連結</a>');
}

async function loadLatestEvents() {
    if (isFetching || !hasMoreData) return;
    isFetching = true;
    loader.classList.add('visible');

    const start = page * PAGE_SIZE;
    const end = start + PAGE_SIZE - 1;
    
    const { data, error } = await supabase
        .from('events')
        .select(`
            *,
            event_politician_map ( politician_id, politicians ( name ) ),
            event_issue_map ( issue_id, issues ( name ) ),
            event_sources ( id, media_name, url, publish_date )
        `)
        .eq('is_visible', true)
        .order('date', { ascending: false })
        .range(start, end);
        
    handleDataResponse(data, error, '綜合最新事件');
}

window.loadSpecificData = async function(type, id, name, pushHistory = true) {
    currentMode = 'specific';
    currentFilterId = id;
    currentTargetName = (type === 'politician') ? name : null;
    
    if (pushHistory) {
        const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname + `?${type === 'politician' ? 'pol' : 'issue'}=${id}`;
        window.history.pushState({path:newUrl}, '', newUrl);
        document.title = `${name} 爭議與言行紀錄 | Polipoli 啪哩啪哩`;
    }

    if (type === 'politician' && currentTab !== 'politicians') {
        switchMainTab('politicians', true);
        document.getElementById('sidebar-search').value = name;
    } else if (type === 'issue' && currentTab !== 'issues') {
        switchMainTab('issues', true);
    }
    
    page = 0;
    hasMoreData = true;
    feedContainer.innerHTML = '';
    endMessage.style.display = 'none';
    document.getElementById('stat-dashboard').style.display = 'none'; 
    
    renderSidebar();
    feedTitle.textContent = type === 'politician' ? `📂 ${name} 的專屬事件簿` : `📌 關於「${name}」的相關事件`;
    loader.classList.add('visible');

    if (id === 'not-found') {
        renderEvents([]);
        hasMoreData = false; 
        loader.classList.remove('visible');
        endMessage.style.display = 'block';
        return;
    }

    let queryResult;
    if (type === 'politician') {
        queryResult = await supabase.from('event_politician_map').select(`
            events!inner (
                *,
                event_politician_map ( politician_id, politicians ( name ) ),
                event_issue_map ( issue_id, issues ( name ) ),
                event_sources ( id, media_name, url, publish_date )
            )
        `).eq('politician_id', id).eq('events.is_visible', true);
    } else {
        queryResult = await supabase.from('event_issue_map').select(`
            events!inner (
                *,
                event_politician_map ( politician_id, politicians ( name ) ),
                event_issue_map ( issue_id, issues ( name ) ),
                event_sources ( id, media_name, url, publish_date )
            )
        `).eq('issue_id', id).eq('events.is_visible', true);
    }

    if (queryResult.error) {
        console.error('特定資料載入失敗:', queryResult.error);
        loader.classList.remove('visible');
        return;
    }

    const eventsData = queryResult.data.map(item => item.events).sort((a, b) => new Date(b.date || '1970-01-01') - new Date(a.date || '1970-01-01'));
    
    const statDashboard = document.getElementById('stat-dashboard');
    if (type === 'politician' && eventsData.length > 0) {
        const totalEvents = eventsData.length;
        let maxSeverity = 0;
        const issueCounts = {};

        eventsData.forEach(e => {
            const sev = parseInt(e.influence) || parseInt(e.severity) || 0; 
            if (sev > maxSeverity) maxSeverity = sev;
            if (e.event_issue_map && Array.isArray(e.event_issue_map)) {
                e.event_issue_map.forEach(m => {
                    if (m.issues && m.issues.name) {
                        issueCounts[m.issues.name] = (issueCounts[m.issues.name] || 0) + 1;
                    }
                });
            }
        });

        let topIssue = '無特定議題';
        let maxIssueCount = 0;
        for (const [issueName, count] of Object.entries(issueCounts)) {
            if (count > maxIssueCount) {
                maxIssueCount = count;
                topIssue = issueName;
            }
        }

        statDashboard.innerHTML = `
            <div class="stat-card">
                <div class="stat-value">${totalEvents}</div>
                <div class="stat-label">總爭議事件 (件)</div>
            </div>
            <div class="stat-card">
                <div class="stat-value" style="font-size: 1.3rem; display: flex; align-items: center; justify-content: center; height: 100%;">${topIssue}</div>
                <div class="stat-label">核心爭議議題</div>
            </div>
            <div class="stat-card">
                <div class="stat-value danger">${maxSeverity}</div>
                <div class="stat-label">最高討論熱度指標</div>
            </div>
        `;
        statDashboard.style.display = 'grid';
    }

    handleDataResponse(eventsData, null, '專屬事件', true);
};

async function handleDataResponse(data, error, logLabel = '資料', isFullData = false) {
    if (error) {
        console.error(`${logLabel}載入失敗:`, error);
        isFetching = false;
        loader.classList.remove('visible');
        return;
    }

    if (data.length < PAGE_SIZE && !isFullData) {
        hasMoreData = false;
        endMessage.style.display = 'block';
    } else if (isFullData) {
        hasMoreData = false;
    }

    renderEvents(data);
    if(!isFullData) page++;
    isFetching = false;
    loader.classList.remove('visible');
}

function injectSchema(events) {
    const oldSchema = document.getElementById('dynamic-schema');
    if (oldSchema) oldSchema.remove();

    const schemaData = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "itemListElement": events.map((e, index) => ({
            "@type": "ListItem",
            "position": index + 1,
            "item": {
                "@type": "ClaimReview",
                "datePublished": e.date,
                "url": window.location.href,
                "claimReviewed": e.quote,
                "reviewRating": {
                    "@type": "Rating",
                    "ratingValue": e.severity,
                    "bestRating": "5",
                    "worstRating": "1"
                },
                "author": {
                    "@type": "Organization",
                    "name": "Polipoli 啪哩啪哩"
                }
            }
        }))
    };
    const script = document.createElement('script');
    script.id = 'dynamic-schema';
    script.type = 'application/ld+json';
    script.text = JSON.stringify(schemaData);
    document.head.appendChild(script);
}

function renderEvents(events) {
    if(events.length > 0) injectSchema(events);
    const html = events.map(e => {
        
        const issueTags = e.event_issue_map?.filter(m => m.issues?.name).map(m => 
            `<span class="info-tag issue-tag" onclick="loadSpecificData('issue', '${m.issue_id}', '${m.issues.name}')">📌 ${m.issues.name}</span>`
        ).join('') || '';
        
        const polTags = e.event_politician_map?.filter(m => m.politicians?.name && m.politicians.name !== currentTargetName).map(m => 
            `<span class="info-tag" onclick="loadSpecificData('politician', '${m.politician_id}', '${m.politicians.name}')">👤 ${m.politicians.name}</span>`
        ).join('') || '';

        const influence = e.influence || e.severity || '-';
        const importance = e.importance || e.severity || '-';

        const infClass = influence >= 4 ? 'high' : '';
        const impClass = importance >= 4 ? 'high' : '';

        const isLiked = userLikedEventIds.has(e.id);
        const likesCount = e.likes_count || 0;
        const likeBtnHtml = `
            <button class="like-btn ${isLiked ? 'liked' : ''}" onclick="toggleLike('${e.id}', this)">
                <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                <span class="like-count">${likesCount}</span>
            </button>
        `;

        let sourceLinks = '';
        if (e.event_sources && e.event_sources.length > 0) {
            e.event_sources.forEach(src => {
                sourceLinks += `
                    <a href="${src.url}" target="_blank" rel="noopener noreferrer" class="source-link">
                        🔗 [${src.media_name}] 查看原始來源
                    </a>`;
            });
        } else if (e.source_url) {
            sourceLinks = `
                <a href="${e.source_url}" target="_blank" rel="noopener noreferrer" class="source-link">
                    🔗 查看原始新聞來源
                </a>`;
        }

        const sourceHtml = `
            <div class="event-actions" style="display: flex; justify-content: space-between; flex-direction: row; align-items: flex-end;">
                <div class="like-container">${likeBtnHtml}</div>
                <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end;">${sourceLinks}</div>
            </div>`;

        const parsedContext = parseContextLinks(e.context);

        return `
            <article class="event-card">
                <div class="tag-row">
                    ${issueTags}
                    ${polTags}
                </div>
                <div class="event-meta">
                    <span class="meta-tag">📅 ${e.date || '日期未明'}</span>
                    <span class="meta-tag severity-tag ${infClass}">🔥 討論度: ${influence}</span>
                    <span class="meta-tag severity-tag ${impClass}">⚠️ 嚴重度: ${importance}</span>
                </div>
                <h3 class="event-quote">「${e.quote}」</h3>
                <div class="event-context">
                    ${parsedContext}
                </div>
                ${sourceHtml}
            </article>
        `;
    }).join('');

    if(events.length === 0 && page === 0) {
        feedContainer.innerHTML = '<div style="text-align:center; padding: 3rem; color: #6b7280; font-weight: bold;">目前尚無相關公開事件。</div>';
    } else {
        feedContainer.insertAdjacentHTML('beforeend', html);
    }
}

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
        if (entries[0].isIntersecting && currentMode === 'latest' && hasMoreData && !isFetching) {
            loadLatestEvents();
        }
    }, options);
    observer.observe(loader);
}

window.toggleLike = async function(eventId, btnElement) {
    const isCurrentlyLiked = userLikedEventIds.has(eventId);
    const countSpan = btnElement.querySelector('.like-count');
    let currentCount = parseInt(countSpan.textContent) || 0;

    if (isCurrentlyLiked) {
        userLikedEventIds.delete(eventId);
        btnElement.classList.remove('liked');
        countSpan.textContent = Math.max(0, currentCount - 1);
        
        const { error } = await supabase.from('event_likes').delete().match({ event_id: eventId, user_uuid: userUUID });
        if (error) {
            userLikedEventIds.add(eventId);
            btnElement.classList.add('liked');
            countSpan.textContent = currentCount;
            console.error('收回讚失敗:', error);
        }
    } else {
        userLikedEventIds.add(eventId);
        btnElement.classList.add('liked');
        countSpan.textContent = currentCount + 1;
        
        const { error } = await supabase.from('event_likes').insert([{ event_id: eventId, user_uuid: userUUID }]);
        if (error) {
            userLikedEventIds.delete(eventId);
            btnElement.classList.remove('liked');
            countSpan.textContent = currentCount;
            console.error('按讚失敗:', error);
        }
    }
};
