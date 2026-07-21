import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

/* ============================================================
   狀態
   ============================================================ */
let currentTab = 'politicians';
let currentMode = 'latest';
let currentFilterId = null;
let currentTargetName = null;

// 用「下一筆要抓的起始位置」取代原本的頁碼制。
// 好處：首頁的前 N 筆案卷已經由 build.mjs 靜態產生，這裡可以直接從
// SSR 已渲染的筆數接續抓取，不必是 PAGE_SIZE 的整數倍也能正確運作，
// 避免捲動載入時出現重複卡片。
let nextOffset = 0;
let isFirstFetch = true;
const PAGE_SIZE = 15;
let isFetching = false;
let hasMoreData = true;

let cachePoliticians = [];
let cacheIssues = [];
let topFivePoliticians = [];

/* ============================================================
   匿名使用者識別（用於按讚去重）
   ============================================================ */
function getUserUUID() {
    const fallback = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
    try {
        let uuid = localStorage.getItem('polipoli_user_uuid');
        if (!uuid) {
            uuid = fallback();
            localStorage.setItem('polipoli_user_uuid', uuid);
        }
        return uuid;
    } catch (e) {
        console.warn('LocalStorage 無法存取，改用單次 session 識別碼');
        return fallback();
    }
}
const userUUID = getUserUUID();
let userLikedEventIds = new Set();

async function fetchUserLikes() {
    try {
        const { data, error } = await supabase.from('event_likes').select('event_id').eq('user_uuid', userUUID);
        if (error) throw error;
        if (data) userLikedEventIds = new Set(data.map(row => row.event_id));
    } catch (e) {
        console.error('讀取按讚紀錄失敗:', e);
    }
}

/* 常被檢舉「難以檢索但高關注」的人名快速標籤 */
const quickPolTags = ['游錫堃', '鄺麗貞', '傅崐萁', '陳玉珍', '徐欣瑩', '張嘉郡', '陳智菡', '黃瀞瑩', '顏寬恒', '佀廣洋'];

const feedContainer = document.getElementById('events-feed');
const loader = document.getElementById('loader');
const endMessage = document.getElementById('end-message');
const feedTitle = document.getElementById('feed-title');
const searchContainer = document.getElementById('sidebar-search-container');
const catalogContainer = document.getElementById('quick-tags-container');
const mobileSelect = document.getElementById('mobile-issue-select');

/* 捲動時把檔案室橫幅收起，讓卡片牆有更多空間 */
let lastScrollTop = 0;
window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
    const header = document.getElementById('main-header');
    if (currentScroll > lastScrollTop && currentScroll > 60) {
        header.classList.add('collapsed');
    } else {
        header.classList.remove('collapsed');
    }
    lastScrollTop = currentScroll <= 0 ? 0 : currentScroll;
});

/* ============================================================
   統一的點擊委派：所有導覽與互動按鈕都用 data-* 屬性標記，
   不再把使用者資料（姓名、引言…）直接拼進 onclick="" 字串裡，
   避免內容剛好帶有單引號時弄壞 HTML 屬性，甚至被拿來注入。
   ============================================================ */
document.addEventListener('click', (e) => {
    const navEl = e.target.closest('[data-nav]');
    if (navEl) {
        // 允許 Ctrl/Cmd/Shift/Alt 或非左鍵點擊照常用瀏覽器原生行為開新分頁，
        // 其餘情況才攔截下來做無刷新的切換。
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        const kind = navEl.dataset.nav;
        if (kind === 'home' || kind === 'reset-latest') { resetToLatest(true); return; }
        if (kind === 'tab') { switchMainTab(navEl.dataset.tab); return; }
        if (kind === 'politician' || kind === 'issue') {
            loadSpecificData(kind, navEl.dataset.id, navEl.dataset.name);
            return;
        }
        return;
    }

    const likeBtn = e.target.closest('[data-like-id]');
    if (likeBtn) { toggleLike(likeBtn.dataset.likeId, likeBtn); return; }

    const reportBtn = e.target.closest('[data-report-id]');
    if (reportBtn) { reportTakeComment(reportBtn.dataset.reportId, reportBtn); return; }

    const submitBtn = e.target.closest('[data-submit-take]');
    if (submitBtn) { submitTakeComment(submitBtn.dataset.submitTake); return; }
});

window.onload = async () => {
    try { await fetchUserLikes(); } catch (e) { console.error('fetchUserLikes failed', e); }
    try { await fetchSidebarData(); } catch (e) { console.error('fetchSidebarData failed', e); }

    // SSG（build.mjs 產生的靜態頁）優先：頁面已內嵌對應的全域變數，
    // 讓爬蟲與尚未執行 JS 的使用者也能看到跟互動後一致的內容。
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
    if (window.__SSG_ANALYSIS_PAGE) {
        currentTab = 'analysis';
        document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('tab-analysis').classList.add('active');
        showAnalysisView();
        return;
    }
    if (window.__SSG_EDITOR_TAKES_PAGE) {
        currentTab = 'editorTakes';
        document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('tab-editorTakes').classList.add('active');
        showEditorTakesView();
        return;
    }
    if (window.__SSG_ISSUES_TAB) {
        currentTab = 'issues';
        document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('tab-issues').classList.add('active');
    }

    // 舊網址參數（?pol= / ?issue=）相容支援
    const urlParams = new URLSearchParams(window.location.search);
    const polId = urlParams.get('pol');
    const issueId = urlParams.get('issue');

    if (polId) {
        const pol = cachePoliticians.find(p => p.id === polId);
        if (pol) { currentTab = 'politicians'; loadSpecificData('politician', pol.id, pol.name, false); }
        else initDefault();
    } else if (issueId) {
        const issue = cacheIssues.find(i => i.id === issueId);
        if (issue) { currentTab = 'issues'; loadSpecificData('issue', issue.id, issue.name, false); }
        else initDefault();
    } else {
        initDefault();
    }

    setupIntersectionObserver();
};

function initDefault() {
    renderSidebar();

    // 首頁／議題總覽頁已由 build.mjs 靜態產生一批案卷（SSR），
    // 這裡從「已經渲染的筆數」接續抓取，不重新請求同一批資料，
    // 避免捲動載入時前面幾筆案卷重複出現。
    const alreadyRendered = feedContainer.querySelectorAll('.event-card').length;
    if (alreadyRendered > 0) {
        nextOffset = alreadyRendered;
        isFirstFetch = false;
    }

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

/* ============================================================
   分頁切換
   ============================================================ */
window.switchMainTab = function (tabName, preventReload = false) {
    if (currentTab === tabName) return;
    currentTab = tabName;

    document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'analysis') { hideEditorTakesView(); showAnalysisView(); return; }
    if (tabName === 'editorTakes') { hideAnalysisView(); showEditorTakesView(); return; }

    hideAnalysisView();
    hideEditorTakesView();

    if (!preventReload) resetToLatest(true);
    else renderSidebar();
};

function showAnalysisView() {
    document.querySelector('.container').classList.add('no-sidebar');
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
    document.getElementById('events-feed').style.display = '';
    document.getElementById('analysis-feed').style.display = 'none';
}
function showEditorTakesView() {
    document.querySelector('.container').classList.add('no-sidebar');
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

/* ============================================================
   站長觀點留言：防洗版參數
   ============================================================ */
const TAKE_COMMENT_COOLDOWN_MS = 30 * 1000;
const TAKE_COMMENT_DAILY_LIMIT = 8;
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
        if (todayCount >= TAKE_COMMENT_DAILY_LIMIT) return '今天的留言次數已達上限，請明天再來。';
        return null;
    } catch (e) { return null; }
}
function commentRateLimitCommit() {
    try {
        const now = Date.now();
        localStorage.setItem('polipoli_last_comment_ts', String(now));
        const todayKey = 'polipoli_comment_count_' + new Date().toISOString().slice(0, 10);
        const todayCount = parseInt(localStorage.getItem(todayKey) || '0', 10);
        localStorage.setItem(todayKey, String(todayCount + 1));
    } catch (e) { /* 略過 */ }
}

function escapeHtmlClient(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTakeContentHtml(raw) {
    const escaped = escapeHtmlClient(raw || '');
    const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const paragraphs = withBold.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
    return paragraphs || `<p>${withBold}</p>`;
}

function renderEditorTakeCommentsHtml(takeId, comments) {
    const list = (comments || []).map(c => `
        <div class="comment-item" id="comment-${c.id}">
            <div class="comment-item-header">
                <span class="comment-author">🙋 ${escapeHtmlClient(c.author_name || '匿名讀者')}</span>
                <span class="comment-date">${(c.created_at || '').slice(0, 10)}</span>
            </div>
            <p class="comment-content">${escapeHtmlClient(c.content)}</p>
            <button class="comment-report-btn" data-report-id="${c.id}">🚩 檢舉</button>
        </div>`).join('');

    return `
        <div class="comment-section" id="comment-section-${takeId}">
            <div class="comment-list" id="comment-list-${takeId}">
                ${list || '<div class="comment-empty">目前尚無留言，成為第一個留言的讀者吧。</div>'}
            </div>
            <div class="comment-form">
                <input type="text" maxlength="30" class="comment-name-input" id="comment-name-${takeId}" placeholder="暱稱（可留空）">
                <input type="text" class="comment-honeypot" id="comment-hp-${takeId}" tabindex="-1" autocomplete="off">
                <textarea class="comment-content-input" id="comment-content-${takeId}" maxlength="${TAKE_COMMENT_MAX_LEN}" placeholder="留下你的看法（最多 ${TAKE_COMMENT_MAX_LEN} 字）"></textarea>
                <button class="btn-comment-submit" data-submit-take="${takeId}">送出留言</button>
            </div>
        </div>`;
}

async function loadEditorTakesFeed() {
    const container = document.getElementById('editor-takes-feed');
    container.innerHTML = '<div class="empty-note">案卷調閱中...</div>';

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
        container.innerHTML = '<div class="empty-note">載入失敗，請稍後再試。</div>';
        console.error(error);
        return;
    }

    let html = '<div class="analysis-disclaimer">⚠️ 以下內容為「站長觀點」，是站長個人的主觀想法與評論，並非本站爭議事件資料庫查證後的事實認定，請自行判斷參考。</div>';

    if (!takes || takes.length === 0) {
        container.innerHTML = html + '<div class="analysis-empty">目前尚無站長觀點。</div>';
        return;
    }

    html += takes.map(t => {
        const polTags = (t.editor_take_politician_map || []).filter(m => m.politicians?.name).map(m =>
            `<span class="info-tag">👤 ${escapeHtmlClient(m.politicians.name)}</span>`).join('');
        const eventTags = (t.editor_take_event_map || []).filter(m => m.events?.quote).map(m =>
            `<span class="info-tag issue-tag">📌 「${escapeHtmlClient(m.events.quote)}」${m.events.date ? `（${escapeHtmlClient(m.events.date)}）` : ''}</span>`).join('');
        const visibleComments = (t.editor_take_comments || []).filter(c => !c.is_hidden)
            .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

        return `
        <article class="event-card editor-take-card">
            <div class="tag-row">
                <span class="editor-take-badge">🗣️ 站長觀點</span>
                <span class="meta-tag">📅 ${escapeHtmlClient((t.created_at || '').slice(0, 10))}</span>
                ${polTags}${eventTags}
            </div>
            <h3 class="event-quote">${escapeHtmlClient(t.title)}</h3>
            <div class="event-context editor-take-content">${renderTakeContentHtml(t.content)}</div>
            ${renderEditorTakeCommentsHtml(t.id, visibleComments)}
        </article>`;
    }).join('');

    container.innerHTML = html;
}

window.submitTakeComment = async function (takeId) {
    const contentEl = document.getElementById(`comment-content-${takeId}`);
    const nameEl = document.getElementById(`comment-name-${takeId}`);
    const hpEl = document.getElementById(`comment-hp-${takeId}`);

    const content = (contentEl?.value || '').trim();
    const authorName = (nameEl?.value || '').trim().slice(0, 30) || '匿名讀者';

    if (hpEl && hpEl.value.trim() !== '') { console.warn('偵測到疑似機器人留言，已略過送出。'); return; }
    if (!content) { alert('留言內容不能是空的！'); return; }
    if (content.length > TAKE_COMMENT_MAX_LEN) { alert(`留言請勿超過 ${TAKE_COMMENT_MAX_LEN} 字！`); return; }
    if (countUrls(content) >= 2) { alert('留言中的連結數量過多，請簡化後再送出。'); return; }
    const lowerContent = content.toLowerCase();
    if (SPAM_KEYWORDS.some(k => lowerContent.includes(k))) { alert('留言內容包含不適當關鍵字，請修改後再送出。'); return; }

    const rateLimitMsg = commentRateLimitCheck();
    if (rateLimitMsg) { alert(rateLimitMsg); return; }

    const { error } = await supabase.from('editor_take_comments').insert([{ editor_take_id: takeId, author_name: authorName, content }]);
    if (error) { alert('留言送出失敗，請稍後再試。'); console.error(error); return; }

    commentRateLimitCommit();
    if (contentEl) contentEl.value = '';
    if (nameEl) nameEl.value = '';

    const { data: comments } = await supabase.from('editor_take_comments')
        .select('id, author_name, content, created_at, is_hidden')
        .eq('editor_take_id', takeId).eq('is_hidden', false)
        .order('created_at', { ascending: true });

    const section = document.getElementById(`comment-section-${takeId}`);
    if (section) section.outerHTML = renderEditorTakeCommentsHtml(takeId, comments || []);
};

window.reportTakeComment = async function (commentId, btnEl) {
    if (!confirm('確定要檢舉這則留言嗎？累積多筆檢舉後將自動隱藏，等候站長複核。')) return;
    const { error } = await supabase.rpc('report_comment', { comment_id: commentId });
    if (error) { alert('檢舉失敗，請稍後再試。'); console.error(error); return; }
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '已檢舉'; }
    alert('已收到檢舉，感謝協助維護留言品質。');
};

async function loadAnalysisFeed() {
    const container = document.getElementById('analysis-feed');
    container.innerHTML = '<div class="empty-note">案卷調閱中...</div>';

    const [{ data: polAnalyses }, { data: evAnalyses }] = await Promise.all([
        supabase.from('politician_analysis').select('content, politicians(name)').eq('is_visible', true),
        supabase.from('event_analysis').select('content, events(quote, date)').eq('is_visible', true)
    ]);

    let html = '<div class="analysis-disclaimer">⚠️ 以下內容為觀點解讀，並非事實認定，請自行判斷參考，並可對照事件原始來源自行查證。</div>';

    html += '<h3 class="analysis-section-title">👤 人物風格分析</h3>';
    html += (polAnalyses && polAnalyses.length > 0) ? polAnalyses.map(a => `
        <div class="analysis-card">
            <div class="analysis-card-header">
                <span class="analysis-badge">⚠️ 觀點分析</span>
                <span class="analysis-target">${a.politicians?.name || '未知人物'}</span>
            </div>
            <p>${a.content}</p>
        </div>`).join('') : '<div class="analysis-empty">目前尚無人物風格分析。</div>';

    html += '<h3 class="analysis-section-title">📌 事件解讀</h3>';
    html += (evAnalyses && evAnalyses.length > 0) ? evAnalyses.map(a => `
        <div class="analysis-card">
            <div class="analysis-card-header">
                <span class="analysis-badge">⚠️ 觀點分析</span>
                <span class="analysis-target">「${a.events?.quote || '未知事件'}」（${a.events?.date || '無日期'}）</span>
            </div>
            <p>${a.content}</p>
        </div>`).join('') : '<div class="analysis-empty">目前尚無事件解讀。</div>';

    container.innerHTML = html;
}

/* ============================================================
   側欄索引
   ============================================================ */
function renderSidebar() {
    const title = document.getElementById('sidebar-title');
    const searchInput = document.getElementById('sidebar-search');

    if (currentTab === 'politicians') {
        title.textContent = '人物檔案索引';
        searchContainer.style.display = 'block';
        mobileSelect.classList.remove('active-tab');
        catalogContainer.classList.remove('issue-grid');

        if (searchInput.value.trim() !== '') filterSidebar();
        else renderSidebarButtons();
    } else {
        title.textContent = '社會議題卷宗';
        searchContainer.style.display = 'none';
        mobileSelect.classList.add('active-tab');
        catalogContainer.classList.add('issue-grid');

        renderSidebarButtons();
        renderMobileIssueSelect();
    }
}

window.renderMobileIssueSelect = function () {
    let options = `<option value="latest" ${currentMode === 'latest' ? 'selected' : ''}>✨ 全部 / 所有事件</option>`;
    cacheIssues.forEach(i => {
        options += `<option value="${i.id}" ${currentFilterId === i.id ? 'selected' : ''}>📌 ${escapeHtmlClient(i.name)}</option>`;
    });
    mobileSelect.innerHTML = options;
};

window.handleMobileIssueSelect = function (val) {
    if (val === 'latest') { resetToLatest(true); return; }
    const issue = cacheIssues.find(i => i.id === val);
    if (issue) loadSpecificData('issue', issue.id, issue.name);
};

/* 小工具：組出可真正導覽（有 href）的索引卡／標籤連結，
   同時掛 data-* 讓上面的委派點擊處理器攔截做無刷新切換。 */
function navAnchor({ type, id, name, active, label, extraClass = '', center = false }) {
    const href = type === 'politician'
        ? `/politician/${encodeURIComponent(name)}/`
        : `/issue/${encodeURIComponent(name)}/`;
    return `<a class="catalog-card ${active ? 'active' : ''} ${extraClass}" ${center ? 'style="justify-content:center;"' : ''}
        href="${href}" data-nav="${type}" data-id="${escapeHtmlClient(id)}" data-name="${escapeHtmlClient(name)}">
        <span>${label}</span>
    </a>`;
}

function renderSidebarButtons() {
    let html = '';

    if (currentTab === 'politicians') {
        const isLatestActive = currentMode === 'latest';
        html += `<a class="catalog-card ${isLatestActive ? 'active' : ''}" style="justify-content:center;" href="/" data-nav="reset-latest"><span>✨ 綜合最新案卷</span></a>`;

        if (topFivePoliticians.length > 0) {
            html += `<div class="section-label">🔥 熱門追蹤人物</div>`;
            html += topFivePoliticians.map(p =>
                navAnchor({ type: 'politician', id: p.id, name: p.name, active: currentFilterId === p.id, label: `👤 ${escapeHtmlClient(p.name)}` })
            ).join('');
        }

        const visibleQuickTags = quickPolTags.filter(tag => cachePoliticians.some(p => p.name === tag));
        const filteredQuickTags = visibleQuickTags.filter(tag => !topFivePoliticians.some(tp => tp.name === tag));

        if (filteredQuickTags.length > 0) {
            html += `<div class="section-label">📌 難檢字快速查</div>`;
            html += filteredQuickTags.map(tag => {
                const p = cachePoliticians.find(pol => pol.name === tag);
                return navAnchor({ type: 'politician', id: p.id, name: p.name, active: currentFilterId === p.id, label: escapeHtmlClient(p.name) });
            }).join('');
        }
    } else {
        const isLatestActive = currentMode === 'latest';
        html += `<a class="catalog-card ${isLatestActive ? 'active' : ''}" style="justify-content:center;" href="/issues/" data-nav="reset-latest"><span>✨ 全部 / 所有事件</span></a>`;
        if (cacheIssues.length > 0) {
            html += cacheIssues.map(i =>
                navAnchor({ type: 'issue', id: i.id, name: i.name, active: currentFilterId === i.id, label: `📌 ${escapeHtmlClient(i.name)}` })
            ).join('');
        }
    }
    catalogContainer.innerHTML = html;
}

window.filterSidebar = function () {
    const rawTerm = document.getElementById('sidebar-search').value.trim();
    const term = rawTerm.toLowerCase();

    if (!term) { renderSidebarButtons(); return; }

    if (currentTab === 'politicians') {
        const filtered = cachePoliticians.filter(p => p.name.toLowerCase().includes(term));
        if (filtered.length === 0) {
            catalogContainer.innerHTML = navAnchor({ type: 'politician', id: 'not-found', name: rawTerm, active: currentFilterId === 'not-found', label: `👤 ${escapeHtmlClient(rawTerm)}` });
        } else {
            catalogContainer.innerHTML = filtered.map(p =>
                navAnchor({ type: 'politician', id: p.id, name: p.name, active: currentFilterId === p.id, label: `👤 ${escapeHtmlClient(p.name)}` })
            ).join('');
        }
    }
};

/* ============================================================
   事件卡輔助渲染
   ============================================================ */
function parseContextLinks(text) {
    if (!text) return '無詳細脈絡說明。';
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escapeHtmlClient(text).replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="source-link" style="display:inline;">🔗 參考連結</a>');
}

function renderImpactMiniBar(score) {
    if (!score) return '';
    const value = Math.min(100, Math.max(0, parseInt(score)));
    return `
        <div class="impact-mini-bar">
            <div class="impact-mini-bar-track">
                <div class="impact-mini-bar-mask" style="width:${100 - value}%"></div>
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
                    <div class="impact-mini-bar-mask" style="width:${100 - value}%"></div>
                </div>
                <span class="impact-mini-bar-score">${value}</span>
            </div>
        </div>`;
}

function renderImpactBox(label, icon, text, score, extraClass) {
    if (!text && !score) return '';
    return `
        <div class="event-impact ${extraClass || ''}">
            <div class="event-impact-header">
                <strong>${icon} ${label}</strong>
                ${renderImpactMiniBar(score)}
            </div>
            ${text ? `<p>${escapeHtmlClient(text)}</p>` : ''}
        </div>`;
}

/* ============================================================
   資料載入
   ============================================================ */
async function loadLatestEvents() {
    if (isFetching || !hasMoreData) return;
    isFetching = true;
    loader.classList.add('visible');

    const start = nextOffset;
    const end = start + PAGE_SIZE - 1;

    const { data, error } = await supabase.from('events').select(`
            *,
            event_politician_map ( politician_id, politicians ( name ) ),
            event_issue_map ( issue_id, issues ( name ) ),
            event_sources ( id, media_name, url, publish_date ),
            event_analysis ( content )
        `).eq('is_visible', true).order('date', { ascending: false }).range(start, end);

    handleDataResponse(data, error, '綜合最新案卷');
}

window.loadSpecificData = async function (type, id, name, pushHistory = true) {
    currentMode = 'specific';
    currentFilterId = id;
    currentTargetName = (type === 'politician') ? name : null;

    if (pushHistory) {
        const newUrl = window.location.protocol + '//' + window.location.host + window.location.pathname + `?${type === 'politician' ? 'pol' : 'issue'}=${id}`;
        window.history.pushState({ path: newUrl }, '', newUrl);
        document.title = `${name} 爭議與言行紀錄 | Polipoli 啪哩啪哩`;
    }

    if (type === 'politician' && currentTab !== 'politicians') {
        switchMainTab('politicians', true);
        document.getElementById('sidebar-search').value = name;
    } else if (type === 'issue' && currentTab !== 'issues') {
        switchMainTab('issues', true);
    }

    nextOffset = 0;
    isFirstFetch = true;
    hasMoreData = true;
    feedContainer.innerHTML = '';
    endMessage.style.display = 'none';
    document.getElementById('stat-dashboard').style.display = 'none';

    renderSidebar();
    feedTitle.textContent = type === 'politician' ? `📂 ${name} 的專屬案卷` : `📌 關於「${name}」的相關案卷`;
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

    const eventsData = queryResult.data.map(item => item.events)
        .sort((a, b) => new Date(b.date || '1970-01-01') - new Date(a.date || '1970-01-01'));

    const statDashboard = document.getElementById('stat-dashboard');
    if (type === 'politician' && eventsData.length > 0) {
        const totalEvents = eventsData.length;
        const peopleScoreSum = eventsData.reduce((sum, e) => sum + (parseInt(e.people_impact_score) || 0), 0);
        const nationalScoreSum = eventsData.reduce((sum, e) => sum + (parseInt(e.national_impact_score) || 0), 0);
        const avgPeopleImpact = totalEvents ? Math.round(peopleScoreSum / totalEvents) : 0;
        const avgNationalImpact = totalEvents ? Math.round(nationalScoreSum / totalEvents) : 0;

        statDashboard.className = 'stat-panel';
        statDashboard.innerHTML = `
            <span class="stat-chip">📊 總案卷數：<b>${totalEvents}</b></span>
            ${renderStatBarRow('對人民影響（平均）', '👥', avgPeopleImpact)}
            ${renderStatBarRow('對國安影響（平均）', '🛡️', avgNationalImpact)}
        `;
        statDashboard.style.display = 'flex';
    }

    handleDataResponse(eventsData, null, '專屬案卷', true);
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
    if (!isFullData) nextOffset += data.length;
    isFirstFetch = false;
    isFetching = false;
    loader.classList.remove('visible');
}

function injectSchema(events) {
    const oldSchema = document.getElementById('dynamic-schema');
    if (oldSchema) oldSchema.remove();

    const schemaData = {
        '@context': 'https://schema.org',
        '@type': 'ItemList',
        itemListElement: events.map((e, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            item: {
                '@type': 'ClaimReview',
                datePublished: e.date,
                url: window.location.href,
                claimReviewed: e.quote,
                reviewRating: { '@type': 'Rating', ratingValue: e.people_impact_score || 0, bestRating: '100', worstRating: '0' },
                author: { '@type': 'Organization', name: 'Polipoli 啪哩啪哩' }
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
    if (events.length > 0) injectSchema(events);

    const html = events.map(e => {
        const issueTags = e.event_issue_map?.filter(m => m.issues?.name).map(m =>
            navAnchor({ type: 'issue', id: m.issue_id, name: m.issues.name, active: false, label: `📌 ${escapeHtmlClient(m.issues.name)}`, extraClass: 'info-tag issue-tag' })
        ).join('') || '';

        const polTags = e.event_politician_map?.filter(m => m.politicians?.name && m.politicians.name !== currentTargetName).map(m =>
            navAnchor({ type: 'politician', id: m.politician_id, name: m.politicians.name, active: false, label: `👤 ${escapeHtmlClient(m.politicians.name)}`, extraClass: 'info-tag' })
        ).join('') || '';

        const isLiked = userLikedEventIds.has(e.id);
        const likesCount = e.likes_count || 0;
        const likeBtnHtml = `
            <button class="like-btn ${isLiked ? 'liked' : ''}" data-like-id="${e.id}">
                <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                <span class="like-count">${likesCount}</span>
            </button>`;

        let sourceLinks = '';
        if (e.event_sources && e.event_sources.length > 0) {
            e.event_sources.forEach(src => {
                sourceLinks += `<a href="${escapeHtmlClient(src.url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 [${escapeHtmlClient(src.media_name)}] 查看原始來源</a>`;
            });
        } else if (e.source_url) {
            sourceLinks = `<a href="${escapeHtmlClient(e.source_url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 查看原始新聞來源</a>`;
        }

        const parsedContext = parseContextLinks(e.context);
        const analysisContent = Array.isArray(e.event_analysis) ? e.event_analysis[0]?.content : e.event_analysis?.content;

        return `
            <article class="event-card">
                <div class="tag-row">
                    <span class="meta-tag">📅 ${escapeHtmlClient(e.date) || '日期未明'}</span>
                    ${polTags}${issueTags}
                </div>
                <h3 class="event-quote">「${escapeHtmlClient(e.quote)}」</h3>
                <div class="event-context">${parsedContext}</div>
                ${e.response_summary ? `<div class="event-response">🗣️ 當事人回應：${escapeHtmlClient(e.response_summary)}</div>` : ''}
                ${analysisContent ? `<div class="site-comment"><div class="site-comment-header"><span class="analysis-badge">⚠️ 觀點分析</span><strong>站長點評</strong></div><p>${escapeHtmlClient(analysisContent)}</p></div>` : ''}
                ${renderImpactBox('對人民的影響', '💥', e.people_impact, e.people_impact_score)}
                ${renderImpactBox('對國安的影響', '🛡️', e.national_security_impact, e.national_impact_score, 'event-impact-security')}
                <div class="event-actions">
                    <div class="like-container">${likeBtnHtml}</div>
                    <div class="source-link-group">${sourceLinks}</div>
                </div>
            </article>`;
    }).join('');

    if (events.length === 0 && isFirstFetch) {
        feedContainer.innerHTML = '<div class="empty-note" style="padding:3rem;text-align:center;">— 查無相關公開案卷 —</div>';
    } else {
        feedContainer.insertAdjacentHTML('beforeend', html);
    }
}

window.resetToLatest = function (force = false) {
    if (!force && currentMode === 'latest' && nextOffset === 0) return;

    const newUrl = window.location.protocol + '//' + window.location.host + (currentTab === 'issues' ? '/issues/' : '/');
    window.history.pushState({ path: newUrl }, '', newUrl);
    document.title = 'Polipoli 啪哩啪哩 | 台灣政治人物爭議事件與雙標言行資料庫';

    currentMode = 'latest';
    currentFilterId = null;
    currentTargetName = null;
    nextOffset = 0;
    isFirstFetch = true;
    hasMoreData = true;
    document.getElementById('sidebar-search').value = '';
    feedContainer.innerHTML = '';

    document.getElementById('stat-dashboard').style.display = 'none';
    feedTitle.textContent = currentTab === 'issues' ? '全部社會議題案卷' : '綜合案卷牆';
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

/* ============================================================
   按讚
   ============================================================ */
const likingInProgress = new Set();

window.toggleLike = async function (eventId, btnElement) {
    if (likingInProgress.has(eventId)) return;
    likingInProgress.add(eventId);

    const allButtonsForEvent = () => document.querySelectorAll(`[data-like-id="${eventId}"]`);
    allButtonsForEvent().forEach(btn => btn.disabled = true);

    const countSpan = btnElement.querySelector('.like-count');
    const currentCount = parseInt(countSpan.textContent);
    const isCurrentlyLiked = btnElement.classList.contains('liked');

    const syncAllButtons = (isLiked, count) => {
        allButtonsForEvent().forEach(btn => {
            btn.classList.toggle('liked', isLiked);
            const span = btn.querySelector('.like-count');
            if (span) span.textContent = count;
        });
    };

    const newLikedState = !isCurrentlyLiked;
    const newCount = newLikedState ? currentCount + 1 : Math.max(0, currentCount - 1);
    syncAllButtons(newLikedState, newCount);

    try {
        if (newLikedState) {
            const { error: likeError } = await supabase.from('event_likes').insert([{ event_id: eventId, user_uuid: userUUID }]);
            if (likeError) throw new Error('點讚失敗: ' + likeError.message);
            const { error: rpcError } = await supabase.rpc('increment_likes', { event_id: eventId });
            if (rpcError) throw new Error('計數更新失敗: ' + rpcError.message);
        } else {
            const { error: likeError } = await supabase.from('event_likes').delete().match({ event_id: eventId, user_uuid: userUUID });
            if (likeError) throw new Error('收回讚失敗: ' + likeError.message);
            const { error: rpcError } = await supabase.rpc('decrement_likes', { event_id: eventId });
            if (rpcError) throw new Error('計數更新失敗: ' + rpcError.message);
        }
        if (newLikedState) userLikedEventIds.add(eventId);
        else userLikedEventIds.delete(eventId);
    } catch (err) {
        console.error(err);
        alert('資料庫操作失敗，已復原。原因: ' + err.message);
        syncAllButtons(isCurrentlyLiked, currentCount);
    } finally {
        likingInProgress.delete(eventId);
        allButtonsForEvent().forEach(btn => btn.disabled = false);
    }
};
