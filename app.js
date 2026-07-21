import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

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

function getUserUUID() {
    const generateFallbackUUID = () => {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };
    try {
        let uuid = localStorage.getItem('polipoli_user_uuid');
        if (!uuid) {
            uuid = generateFallbackUUID();
            localStorage.setItem('polipoli_user_uuid', uuid);
        }
        return uuid;
    } catch (e) {
        console.warn('LocalStorage 存取受限，使用單次 Session UUID');
        return generateFallbackUUID();
    }
}
const userUUID = getUserUUID();
let userLikedEventIds = new Set();

async function fetchUserLikes() {
    try {
        const { data, error } = await supabase.from('event_likes').select('event_id').eq('user_uuid', userUUID);
        if (error) throw error;
        if (data) {
            userLikedEventIds = new Set(data.map(item => item.event_id));
        }
    } catch(e) { 
        console.error('讀取按讚紀錄失敗:', e); 
    }
}

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
    try {
        await fetchUserLikes();
    } catch(e) { console.error('fetchUserLikes failed', e); }
    
    try {
        await fetchSidebarData();
    } catch(e) { console.error('fetchSidebarData failed', e); }

    // 靜態頁面（SSG）優先：由 build.mjs 產生的頁面會內嵌這些全域變數，
    // 讓爬蟲看到的內容跟使用者實際互動的內容一致（hydration）
    if (window.__SSG_POLITICIAN_ID) {
        currentTab = 'politicians';
        loadSpecificData('politician', window.__SSG_POLITICIAN_ID, window.__SSG_POLITICIAN_NAME, false);
        setupIntersectionObserver();
        return;
    }
    if (window.__SSG_ISSUE_ID) {
        currentTab = 'issues';
        loadSpecificData('issue', window.__SSG_ISSUE_ID, window.__SSG_ISSUE_NAME, false);
        setupIntersectionObserver();
        return;
    }

    // 舊有的 query string 路由方式，維持向下相容
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

    if (tabName === 'analysis') {
        hideEditorTakesView();
        showAnalysisView();
        return;
    }
    if (tabName === 'editorTakes') {
        hideAnalysisView();
        showEditorTakesView();
        return;
    }
    hideAnalysisView();
    hideEditorTakesView();
    
    if (!preventReload) {
        resetToLatest(true);
    } else {
        renderSidebar();
    }
};

function showAnalysisView() {
    document.querySelector('.container').classList.add('no-sidebar');
    document.querySelector('aside').style.display = 'none';
    document.getElementById('events-feed').style.display = 'none';
    document.getElementById('stat-dashboard').style.display = 'none';
    document.getElementById('loader').classList.remove('visible');
    document.getElementById('end-message').style.display = 'none';
    document.getElementById('feed-title').textContent = '🔍 分析與紀錄';
    document.getElementById('analysis-feed').style.display = 'block';
    loadAnalysisFeed();
}

function hideAnalysisView() {
    document.querySelector('.container').classList.remove('no-sidebar');
    document.querySelector('aside').style.display = '';
    document.getElementById('events-feed').style.display = '';
    document.getElementById('analysis-feed').style.display = 'none';
}

function showEditorTakesView() {
    document.querySelector('.container').classList.add('no-sidebar');
    document.querySelector('aside').style.display = 'none';
    document.getElementById('events-feed').style.display = 'none';
    document.getElementById('stat-dashboard').style.display = 'none';
    document.getElementById('loader').classList.remove('visible');
    document.getElementById('end-message').style.display = 'none';
    document.getElementById('feed-title').textContent = '🗣️ 站長觀點';
    document.getElementById('editor-takes-feed').style.display = 'block';
    loadEditorTakesFeed();
}

function hideEditorTakesView() {
    const feed = document.getElementById('editor-takes-feed');
    if (feed) feed.style.display = 'none';
}

// ===== 站長觀點：留言防護參數 =====
const TAKE_COMMENT_COOLDOWN_MS = 30 * 1000; // 同一裝置兩則留言間隔
const TAKE_COMMENT_DAILY_LIMIT = 8; // 同一裝置每日留言上限
const TAKE_COMMENT_MAX_LEN = 500;
const SPAM_KEYWORDS = ['viagra', '博彩', '娛樂城', '色情', 'http://bit.ly', 'wechat', '加line'];

function countUrls(text) {
    const m = text.match(/https?:\/\/|www\./gi);
    return m ? m.length : 0;
}

function commentRateLimitCheck() {
    try {
        const now = Date.now();
        const lastTs = parseInt(localStorage.getItem('polipoli_last_comment_ts') || '0', 10);
        if (now - lastTs < TAKE_COMMENT_COOLDOWN_MS) {
            return `留言太頻繁了，請稍等 ${Math.ceil((TAKE_COMMENT_COOLDOWN_MS - (now - lastTs)) / 1000)} 秒再試。`;
        }
        const todayKey = 'polipoli_comment_count_' + new Date().toISOString().slice(0, 10);
        const todayCount = parseInt(localStorage.getItem(todayKey) || '0', 10);
        if (todayCount >= TAKE_COMMENT_DAILY_LIMIT) {
            return '今天的留言次數已達上限，請明天再來。';
        }
        return null;
    } catch (e) {
        return null;
    }
}

function commentRateLimitCommit() {
    try {
        const now = Date.now();
        localStorage.setItem('polipoli_last_comment_ts', String(now));
        const todayKey = 'polipoli_comment_count_' + new Date().toISOString().slice(0, 10);
        const todayCount = parseInt(localStorage.getItem(todayKey) || '0', 10);
        localStorage.setItem(todayKey, String(todayCount + 1));
    } catch (e) { /* localStorage 不可用時略過限流紀錄 */ }
}

function renderEditorTakeCommentsHtml(takeId, comments) {
    const list = (comments || []).map(c => `
        <div class="comment-item" id="comment-${c.id}">
            <div class="comment-item-header">
                <span class="comment-author">🙋 ${escapeHtmlClient(c.author_name || '匿名讀者')}</span>
                <span class="comment-date">${(c.created_at || '').slice(0, 10)}</span>
            </div>
            <p class="comment-content">${escapeHtmlClient(c.content)}</p>
            <button class="comment-report-btn" onclick="reportTakeComment('${c.id}', this)">🚩 檢舉</button>
        </div>
    `).join('');

    return `
        <div class="comment-section" id="comment-section-${takeId}">
            <div class="comment-list" id="comment-list-${takeId}">
                ${list || '<div class="comment-empty">目前尚無留言，成為第一個留言的讀者吧。</div>'}
            </div>
            <div class="comment-form">
                <input type="text" maxlength="30" class="comment-name-input" id="comment-name-${takeId}" placeholder="暱稱（可留空）">
                <input type="text" class="comment-honeypot" id="comment-hp-${takeId}" style="position:absolute;left:-9999px;" tabindex="-1" autocomplete="off">
                <textarea class="comment-content-input" id="comment-content-${takeId}" maxlength="${TAKE_COMMENT_MAX_LEN}" placeholder="留下你的看法（最多 ${TAKE_COMMENT_MAX_LEN} 字）"></textarea>
                <button class="btn-comment-submit" onclick="submitTakeComment('${takeId}')">送出留言</button>
            </div>
        </div>`;
}

function escapeHtmlClient(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 將站長觀點內容轉為有段落、有粗體的 HTML。
// 先做 HTML escape 避免 XSS，再把常見的簡易 Markdown 語法（**粗體**、換行）轉成標籤。
function renderTakeContentHtml(raw) {
    const escaped = escapeHtmlClient(raw || '');
    const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const paragraphs = withBold
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('');
    return paragraphs || `<p>${withBold}</p>`;
}

async function loadEditorTakesFeed() {
    const container = document.getElementById('editor-takes-feed');
    container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">載入中...</div>';

    const { data: takes, error } = await supabase.from('editor_takes')
        .select(`
            id, title, content, created_at,
            editor_take_politician_map ( politician_id, politicians ( name ) ),
            editor_take_event_map ( event_id, events ( quote, date ) ),
            editor_take_comments ( id, author_name, content, created_at, is_hidden )
        `)
        .eq('is_visible', true)
        .order('created_at', { ascending: false });

    if (error) {
        container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">載入失敗，請稍後再試。</div>';
        console.error(error);
        return;
    }

    let html = '<div class="analysis-disclaimer">⚠️ 以下內容為「站長觀點」，是站長個人的主觀想法與評論，並非本站爭議事件資料庫查證後的事實認定，請自行判斷參考。</div>';

    if (!takes || takes.length === 0) {
        html += '<div class="analysis-empty">目前尚無站長觀點。</div>';
        container.innerHTML = html;
        return;
    }

    html += takes.map(t => {
        const polTags = (t.editor_take_politician_map || []).filter(m => m.politicians?.name).map(m =>
            `<span class="info-tag">👤 ${escapeHtmlClient(m.politicians.name)}</span>`
        ).join('');
        const eventTags = (t.editor_take_event_map || []).filter(m => m.events?.quote).map(m =>
            `<span class="info-tag issue-tag">📌 「${escapeHtmlClient(m.events.quote)}」${m.events.date ? `（${escapeHtmlClient(m.events.date)}）` : ''}</span>`
        ).join('');
        const visibleComments = (t.editor_take_comments || []).filter(c => !c.is_hidden)
            .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

        return `
        <article class="event-card editor-take-card">
            <div class="tag-row">
                <span class="editor-take-badge">🗣️ 站長觀點（主觀評論）</span>
                <span class="meta-tag">📅 ${escapeHtmlClient((t.created_at || '').slice(0, 10))}</span>
                ${polTags}
                ${eventTags}
            </div>
            <h3 class="event-quote">${escapeHtmlClient(t.title)}</h3>
            <div class="event-context editor-take-content">${renderTakeContentHtml(t.content)}</div>
            ${renderEditorTakeCommentsHtml(t.id, visibleComments)}
        </article>`;
    }).join('');

    container.innerHTML = html;
}

window.submitTakeComment = async function(takeId) {
    const contentEl = document.getElementById(`comment-content-${takeId}`);
    const nameEl = document.getElementById(`comment-name-${takeId}`);
    const hpEl = document.getElementById(`comment-hp-${takeId}`);

    const content = (contentEl?.value || '').trim();
    const authorName = (nameEl?.value || '').trim().slice(0, 30) || '匿名讀者';

    // 蜜罐欄位：一般使用者看不到也不會填寫，機器人常會自動填入
    if (hpEl && hpEl.value.trim() !== '') {
        console.warn('偵測到疑似機器人留言，已略過送出。');
        return;
    }

    if (!content) { alert('留言內容不能是空的！'); return; }
    if (content.length > TAKE_COMMENT_MAX_LEN) { alert(`留言請勿超過 ${TAKE_COMMENT_MAX_LEN} 字！`); return; }
    if (countUrls(content) >= 2) { alert('留言中的連結數量過多，請簡化後再送出。'); return; }
    const lowerContent = content.toLowerCase();
    if (SPAM_KEYWORDS.some(k => lowerContent.includes(k))) {
        alert('留言內容包含不適當關鍵字，請修改後再送出。');
        return;
    }

    const rateLimitMsg = commentRateLimitCheck();
    if (rateLimitMsg) { alert(rateLimitMsg); return; }

    const { error } = await supabase.from('editor_take_comments').insert([{
        editor_take_id: takeId,
        author_name: authorName,
        content
    }]);

    if (error) {
        alert('留言送出失敗，請稍後再試。');
        console.error(error);
        return;
    }

    commentRateLimitCommit();
    if (contentEl) contentEl.value = '';
    if (nameEl) nameEl.value = '';

    // 重新載入該則留言區，顯示剛送出的留言
    const { data: comments } = await supabase.from('editor_take_comments')
        .select('id, author_name, content, created_at, is_hidden')
        .eq('editor_take_id', takeId)
        .eq('is_hidden', false)
        .order('created_at', { ascending: true });

    const section = document.getElementById(`comment-section-${takeId}`);
    if (section) {
        section.outerHTML = renderEditorTakeCommentsHtml(takeId, comments || []);
    }
};

window.reportTakeComment = async function(commentId, btnEl) {
    if (!confirm('確定要檢舉這則留言嗎？累積多筆檢舉後將自動隱藏，等候站長複核。')) return;
    const { error } = await supabase.rpc('report_comment', { comment_id: commentId });
    if (error) {
        alert('檢舉失敗，請稍後再試。');
        console.error(error);
        return;
    }
    if (btnEl) {
        btnEl.disabled = true;
        btnEl.textContent = '已檢舉';
    }
    alert('已收到檢舉，感謝協助維護留言品質。');
};

async function loadAnalysisFeed() {
    const container = document.getElementById('analysis-feed');
    container.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">載入中...</div>';

    const [{ data: polAnalyses }, { data: evAnalyses }] = await Promise.all([
        supabase.from('politician_analysis').select('content, politicians(name)').eq('is_visible', true),
        supabase.from('event_analysis').select('content, events(quote, date)').eq('is_visible', true)
    ]);

    let html = '<div class="analysis-disclaimer">⚠️ 以下內容為觀點解讀，並非事實認定，請自行判斷參考，並可對照事件原始來源自行查證。</div>';

    html += '<h3 class="analysis-section-title">👤 人物風格分析</h3>';
    if (polAnalyses && polAnalyses.length > 0) {
        html += polAnalyses.map(a => `
            <div class="analysis-card">
                <div class="analysis-card-header">
                    <span class="analysis-badge">⚠️ 觀點分析</span>
                    <span class="analysis-target">${a.politicians?.name || '未知人物'}</span>
                </div>
                <p>${a.content}</p>
            </div>
        `).join('');
    } else {
        html += '<div class="analysis-empty">目前尚無人物風格分析。</div>';
    }

    html += '<h3 class="analysis-section-title">📌 事件解讀</h3>';
    if (evAnalyses && evAnalyses.length > 0) {
        html += evAnalyses.map(a => `
            <div class="analysis-card">
                <div class="analysis-card-header">
                    <span class="analysis-badge">⚠️ 觀點分析</span>
                    <span class="analysis-target">「${a.events?.quote || '未知事件'}」（${a.events?.date || '無日期'}）</span>
                </div>
                <p>${a.content}</p>
            </div>
        `).join('');
    } else {
        html += '<div class="analysis-empty">目前尚無事件解讀。</div>';
    }

    container.innerHTML = html;
}

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

function renderImpactMiniBar(score) {
    if (!score) return '';
    const value = Math.min(100, Math.max(0, parseInt(score)));
    return `
        <div class="impact-mini-bar">
            <div class="impact-mini-bar-track">
                <div class="impact-mini-bar-mask" style="width: ${100 - value}%"></div>
            </div>
            <span class="impact-mini-bar-score">${value}</span>
        </div>`;
}

function renderStatBarRow(label, icon, avgScore) {
    const value = Math.min(100, Math.max(0, avgScore || 0));
    return `
        <div class="stat-row">
            <span class="stat-row-label">${icon} ${label}</span>
            <div class="stat-row-bar">
                <div class="impact-mini-bar-track wide">
                    <div class="impact-mini-bar-mask" style="width: ${100 - value}%"></div>
                </div>
                <span class="impact-mini-bar-score">${value}</span>
            </div>
        </div>`;
}

function renderImpactBox(label, icon, text, score, extraClass) {
    if (!text && !score) return ''; // 文字與分數都沒有就整個不顯示
    return `
        <div class="event-impact ${extraClass || ''}">
            <div class="event-impact-header">
                <strong>${icon} ${label}</strong>
                ${renderImpactMiniBar(score)}
            </div>
            ${text ? `<p>${text}</p>` : ''}
        </div>`;
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
            event_sources ( id, media_name, url, publish_date ),
            event_analysis ( content )
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
                event_sources ( id, media_name, url, publish_date ),
                event_analysis ( content )
            )
        `).eq('politician_id', id).eq('events.is_visible', true);
    } else {
        queryResult = await supabase.from('event_issue_map').select(`
            events!inner (
                *,
                event_politician_map ( politician_id, politicians ( name ) ),
                event_issue_map ( issue_id, issues ( name ) ),
                event_sources ( id, media_name, url, publish_date ),
                event_analysis ( content )
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

        const peopleScoreSum = eventsData.reduce((sum, e) => sum + (parseInt(e.people_impact_score) || 0), 0);
        const nationalScoreSum = eventsData.reduce((sum, e) => sum + (parseInt(e.national_impact_score) || 0), 0);
        const avgPeopleImpact = totalEvents ? Math.round(peopleScoreSum / totalEvents) : 0;
        const avgNationalImpact = totalEvents ? Math.round(nationalScoreSum / totalEvents) : 0;

        statDashboard.innerHTML = `
            <div class="stat-row">
                <span class="stat-row-label">📊 總爭議事件 (件)</span>
                <span class="stat-row-value">${totalEvents}</span>
            </div>
            ${renderStatBarRow('對人民影響分數（平均）', '👥', avgPeopleImpact)}
            ${renderStatBarRow('對國安影響分數（平均）', '🛡️', avgNationalImpact)}
        `;
        statDashboard.style.display = 'flex';
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
                    "ratingValue": e.people_impact_score || 0,
                    "bestRating": "100",
                    "worstRating": "0"
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
        const analysisContent = Array.isArray(e.event_analysis) ? e.event_analysis[0]?.content : e.event_analysis?.content;

        return `
            <article class="event-card">
                <div class="tag-row">
                    <span class="meta-tag">📅 ${e.date || '日期未明'}</span>
                    ${polTags}
                    ${issueTags}
                </div>
                <h3 class="event-quote">「${e.quote}」</h3>
                <div class="event-context">
                    ${parsedContext}
                </div>
                ${e.response_summary ? `<div class="event-response">🗣️ 當事人回應：${e.response_summary}</div>` : ''}
                ${analysisContent ? `<div class="site-comment"><div class="site-comment-header"><span class="analysis-badge">⚠️ 觀點分析</span><strong>站長點評</strong></div><p>${analysisContent}</p></div>` : ''}
                ${renderImpactBox('對人民的影響', '💥', e.people_impact, e.people_impact_score)}
                ${renderImpactBox('對國安的影響', '🛡️', e.national_security_impact, e.national_impact_score, 'event-impact-security')}
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

const likingInProgress = new Set(); // 記錄目前正在處理中的 eventId，避免重複點擊造成 race condition

window.toggleLike = async function(eventId, btnElement) {
    // 0. 防止重複點擊：同一個事件正在處理中就直接忽略
    if (likingInProgress.has(eventId)) return;
    likingInProgress.add(eventId);

    const allButtonsForEvent = () => document.querySelectorAll(`button[onclick*="'${eventId}'"]`);
    allButtonsForEvent().forEach(btn => btn.disabled = true);

    // 1. 取得當前卡片的 DOM 參考
    const countSpan = btnElement.querySelector('.like-count');
    const currentCount = parseInt(countSpan.textContent);
    const userUUID = getUserUUID();
    const isCurrentlyLiked = btnElement.classList.contains('liked');

    // 2. 定義廣播函式：一次更新頁面上所有同 ID 的卡片
    const syncAllButtons = (isLiked, count) => {
        allButtonsForEvent().forEach(btn => {
            if (isLiked) {
                btn.classList.add('liked');
            } else {
                btn.classList.remove('liked');
            }
            const span = btn.querySelector('.like-count');
            if (span) span.textContent = count;
        });
    };

    // 3. 樂觀更新 (UI 先動)
    const newLikedState = !isCurrentlyLiked;
    const newCount = newLikedState ? currentCount + 1 : Math.max(0, currentCount - 1);
    syncAllButtons(newLikedState, newCount);

    // 4. 與資料庫同步
    try {
        if (newLikedState) {
            // 新增讚
            const { error: likeError } = await supabase.from('event_likes').insert([{ event_id: eventId, user_uuid: userUUID }]);
            if (likeError) throw new Error('點讚失敗: ' + likeError.message);
            const { error: rpcError } = await supabase.rpc('increment_likes', { event_id: eventId });
            if (rpcError) throw new Error('計數更新失敗: ' + rpcError.message);
        } else {
            // 收回讚
            const { error: likeError } = await supabase.from('event_likes').delete().match({ event_id: eventId, user_uuid: userUUID });
            if (likeError) throw new Error('收回讚失敗: ' + likeError.message);
            const { error: rpcError } = await supabase.rpc('decrement_likes', { event_id: eventId });
            if (rpcError) throw new Error('計數更新失敗: ' + rpcError.message);
        }
        // 5. 同步成功後，更新記憶體中的已讚清單，避免切換頁籤/重新渲染時讀到舊狀態
        if (newLikedState) {
            userLikedEventIds.add(eventId);
        } else {
            userLikedEventIds.delete(eventId);
        }
    } catch (err) {
        // 若失敗，復原至原本狀態
        console.error(err);
        alert('資料庫操作失敗，已復原。原因: ' + err.message);
        syncAllButtons(isCurrentlyLiked, currentCount);
    } finally {
        likingInProgress.delete(eventId);
        allButtonsForEvent().forEach(btn => btn.disabled = false);
    }
};

