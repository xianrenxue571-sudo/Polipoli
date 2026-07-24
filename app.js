import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

/* ============================================================
   狀態
   ============================================================ */
let currentTab = 'politicians';
let currentMode = 'latest';
// 人物篩選跟議題篩選現在是兩個獨立的條件，可以同時生效（交叉篩選），
// 不再是「選一個蓋掉另一個」的單一篩選狀態。
let activePoliticianId = null;
let activePoliticianName = null;
let activeIssueId = null;
let activeIssueName = null;
let currentTargetName = null; // 目前篩選的人物姓名，用來在事件卡上隱藏「自己標自己」的重複標籤

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
// 人物 <-> 議題 的交叉對照表：用來讓兩個下拉選單「反推」互相動態縮小範圍
let politicianToIssueIds = {}; // politician_id -> Set(issue_id)
let issueToPoliticianIds = {}; // issue_id -> Set(politician_id)

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

const feedContainer = document.getElementById('events-feed');
const loader = document.getElementById('loader');
const endMessage = document.getElementById('end-message');
const feedTitle = document.getElementById('feed-title');
const searchContainer = document.getElementById('sidebar-search-container');
const catalogContainer = document.getElementById('quick-tags-container');
const politicianSelect = document.getElementById('politician-select');
const issueSelect = document.getElementById('issue-category-select');
const sidebarSearchInput = document.getElementById('sidebar-search');
const statDashboard = document.getElementById('stat-dashboard');
const containerEl = document.querySelector('.container');
const editorTakesFeedEl = document.getElementById('editor-takes-feed');
const majorEventsFeedEl = document.getElementById('major-events-feed');
const mainHeader = document.getElementById('main-header');
const scrollTopBtn = document.getElementById('scroll-top-btn');

/* 捲動時把檔案室橫幅收起，讓卡片牆有更多空間 */
let lastScrollTop = 0;
window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset || document.documentElement.scrollTop;
    if (currentScroll > lastScrollTop && currentScroll > 60) {
        mainHeader.classList.add('collapsed');
    } else {
        mainHeader.classList.remove('collapsed');
    }
    lastScrollTop = currentScroll <= 0 ? 0 : currentScroll;

    if (scrollTopBtn) scrollTopBtn.classList.toggle('visible', currentScroll > 300);
});

/* ============================================================
   回頂部浮動按鈕：單純點擊會捲回頂部；按住拖曳則移動位置，
   放開後記住新位置（存在 localStorage），下次開站還在原地。
   ============================================================ */
function initScrollTopButton() {
    if (!scrollTopBtn) return;

    try {
        const saved = JSON.parse(localStorage.getItem('polipoli_scrolltop_pos') || 'null');
        if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
            const size = 48;
            const margin = 4;
            const safeRight = Math.min(Math.max(saved.right, margin), window.innerWidth - size - margin);
            const safeBottom = Math.min(Math.max(saved.bottom, margin), window.innerHeight - size - margin);
            scrollTopBtn.style.right = safeRight + 'px';
            scrollTopBtn.style.bottom = safeBottom + 'px';
        }
    } catch (e) { /* 忽略壞掉的舊資料 */ }

    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0, startRight = 0, startBottom = 0;

    scrollTopBtn.addEventListener('pointerdown', (e) => {
        isDragging = true;
        hasMoved = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = scrollTopBtn.getBoundingClientRect();
        startRight = window.innerWidth - rect.right;
        startBottom = window.innerHeight - rect.bottom;
        scrollTopBtn.setPointerCapture(e.pointerId);
        scrollTopBtn.classList.add('dragging');
    });

    scrollTopBtn.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) hasMoved = true;
        if (!hasMoved) return;

        const size = scrollTopBtn.offsetWidth;
        const margin = 4;
        const newRight = Math.min(Math.max(startRight - dx, margin), window.innerWidth - size - margin);
        const newBottom = Math.min(Math.max(startBottom - dy, margin), window.innerHeight - size - margin);

        scrollTopBtn.style.right = newRight + 'px';
        scrollTopBtn.style.bottom = newBottom + 'px';
    });

    scrollTopBtn.addEventListener('pointerup', (e) => {
        if (!isDragging) return;
        isDragging = false;
        scrollTopBtn.classList.remove('dragging');
        scrollTopBtn.releasePointerCapture(e.pointerId);

        if (hasMoved) {
            const rect = scrollTopBtn.getBoundingClientRect();
            const pos = { right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.bottom };
            try { localStorage.setItem('polipoli_scrolltop_pos', JSON.stringify(pos)); } catch (e) { /* 忽略 */ }
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    });
}
initScrollTopButton();

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
        if (kind === 'majorEventLink') {
            pendingExpandMajorEventId = navEl.dataset.id;
            switchMainTab('majorEvents');
            return;
        }
        if (kind === 'editorTakeLink') {
            pendingScrollToTakeId = navEl.dataset.id;
            switchMainTab('editorTakes');
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

    const toggleMajorEventBtn = e.target.closest('[data-toggle-major-event]');
    if (toggleMajorEventBtn) {
        const card = toggleMajorEventBtn.closest('.major-event-card');
        if (card) {
            const isExpanding = !card.classList.contains('expanded');
            card.classList.toggle('expanded');
            const id = toggleMajorEventBtn.dataset.toggleMajorEvent;
            // 用 replaceState 而非 pushState：展開/收合不需要各自佔一筆瀏覽紀錄，
            // 只是讓「目前網址」記得住是哪一張卡片被展開，離開後按上一頁才回得來。
            const newUrl = window.location.pathname + (isExpanding ? `#event-${id}` : '');
            window.history.replaceState(null, '', newUrl);
        }
        return;
    }
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
        currentTab = 'politicians';
        loadSpecificData('issue', window.__SSG_ISSUE_ID, window.__SSG_ISSUE_NAME, false);
        setupIntersectionObserver();
        return;
    }
    if (window.__SSG_EDITOR_TAKES_PAGE) {
        currentTab = 'editorTakes';
        document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('tab-editorTakes').classList.add('active');
        if (window.location.hash.startsWith('#take-')) {
            pendingScrollToTakeId = window.location.hash.slice('#take-'.length);
        }
        showEditorTakesView();
        return;
    }
    if (window.__SSG_MAJOR_EVENTS_PAGE) {
        currentTab = 'majorEvents';
        document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('tab-majorEvents').classList.add('active');
        if (window.location.hash.startsWith('#event-')) {
            pendingExpandMajorEventId = window.location.hash.slice('#event-'.length);
        }
        showMajorEventsView();
        return;
    }

    // 舊網址參數（?pol= / ?issue=）相容支援，現在也支援兩者同時出現
    const urlParams = new URLSearchParams(window.location.search);
    const polId = urlParams.get('pol');
    const issueId = urlParams.get('issue');

    if (polId || issueId) {
        currentTab = 'politicians';
        let matched = false;
        if (polId) {
            const pol = cachePoliticians.find(p => p.id === polId);
            if (pol) { activePoliticianId = pol.id; activePoliticianName = pol.name; matched = true; }
        }
        if (issueId) {
            const issue = cacheIssues.find(i => i.id === issueId);
            if (issue) { activeIssueId = issue.id; activeIssueName = issue.name; matched = true; }
        }
        if (matched) applyFilters(false);
        else initDefault();
    } else {
        initDefault();
    }

    setupIntersectionObserver();
};

/* ============================================================
   瀏覽器上一頁／下一頁：原本整站只有「往前」時用 pushState 換網址，
   卻完全沒有監聽 popstate，導致按上一頁網址雖然變了，畫面卻不會跟著變回去。
   這裡統一用目前網址反推出該顯示哪個畫面，讓上一頁/下一頁真正可用。
   ============================================================ */
let pendingExpandMajorEventId = null;
let pendingScrollToTakeId = null;

function syncViewToUrl() {
    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const hash = window.location.hash;

    document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));

    if (path.startsWith('/major-events')) {
        currentTab = 'majorEvents';
        document.getElementById('tab-majorEvents').classList.add('active');
        restoreDefaultLayout();
        hideEditorTakesView();
        if (hash.startsWith('#event-')) pendingExpandMajorEventId = hash.slice('#event-'.length);
        showMajorEventsView();
        return;
    }
    if (path.startsWith('/editor-takes')) {
        currentTab = 'editorTakes';
        document.getElementById('tab-editorTakes').classList.add('active');
        restoreDefaultLayout();
        hideMajorEventsView();
        if (hash.startsWith('#take-')) pendingScrollToTakeId = hash.slice('#take-'.length);
        showEditorTakesView();
        return;
    }

    // 其餘都算「人物言行」：依網址參數還原目前的人物/議題篩選狀態
    currentTab = 'politicians';
    document.getElementById('tab-politicians').classList.add('active');
    restoreDefaultLayout();
    hideEditorTakesView();
    hideMajorEventsView();

    const polId = params.get('pol');
    const issueId = params.get('issue');
    activePoliticianId = null;
    activePoliticianName = null;
    activeIssueId = null;
    activeIssueName = null;
    if (polId) {
        const pol = cachePoliticians.find(p => p.id === polId);
        if (pol) { activePoliticianId = pol.id; activePoliticianName = pol.name; }
    }
    if (issueId) {
        const issue = cacheIssues.find(i => i.id === issueId);
        if (issue) { activeIssueId = issue.id; activeIssueName = issue.name; }
    }
    applyFilters(false);
}

window.addEventListener('popstate', syncViewToUrl);

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
    const [polRes, issueRes, polMapRes, issueMapRes] = await Promise.all([
        supabase.from('politicians').select('*').eq('is_visible', true).order('name'),
        supabase.from('issues').select('*').eq('is_visible', true).order('name'),
        // 用 !inner 只抓「掛在公開事件上」的關聯，避免只掛在待審核事件上的也被算進去
        supabase.from('event_politician_map').select('politician_id, event_id, events!inner(is_visible)').eq('events.is_visible', true),
        supabase.from('event_issue_map').select('issue_id, event_id, events!inner(is_visible)').eq('events.is_visible', true)
    ]);

    const rawPoliticians = polRes.data || [];
    const rawIssues = issueRes.data || [];
    const polMapData = polMapRes.data || [];
    const issueMapData = issueMapRes.data || [];

    if (polMapData.length > 0) {
        const counts = polMapData.reduce((acc, cur) => {
            acc[cur.politician_id] = (acc[cur.politician_id] || 0) + 1;
            return acc;
        }, {});
        // 只留下至少有一筆公開案卷的人物：沒有案卷的話，選了/連了也只會看到空白頁，不如不要出現
        cachePoliticians = rawPoliticians.filter(p => counts[p.id] > 0);
        const topFiveIds = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 5);
        topFivePoliticians = cachePoliticians.filter(p => topFiveIds.includes(p.id));
    } else {
        cachePoliticians = [];
        topFivePoliticians = [];
    }

    if (issueMapData.length > 0) {
        const issueIdsWithEvents = new Set(issueMapData.map(r => r.issue_id));
        // 議題分類比照人物的邏輯：沒有任何公開案卷掛在這個議題底下，就不出現在下拉選單裡
        cacheIssues = rawIssues.filter(i => issueIdsWithEvents.has(i.id));
    } else {
        cacheIssues = [];
    }

    // 建立「同一筆事件裡，人物跟議題曾經同時出現過」的交叉對照表，
    // 讓側欄兩個下拉選單可以「反推」：選了其中一個，另一個只列出真正有交集的選項。
    const politiciansByEvent = {};
    polMapData.forEach(r => { (politiciansByEvent[r.event_id] ||= []).push(r.politician_id); });
    const issuesByEvent = {};
    issueMapData.forEach(r => { (issuesByEvent[r.event_id] ||= []).push(r.issue_id); });

    politicianToIssueIds = {};
    issueToPoliticianIds = {};
    Object.keys(politiciansByEvent).forEach(eventId => {
        const pols = politiciansByEvent[eventId] || [];
        const iss = issuesByEvent[eventId] || [];
        pols.forEach(pid => {
            iss.forEach(iid => {
                (politicianToIssueIds[pid] ||= new Set()).add(iid);
                (issueToPoliticianIds[iid] ||= new Set()).add(pid);
            });
        });
    });
}

/* ============================================================
   分頁切換
   ============================================================ */
window.switchMainTab = function (tabName, preventReload = false) {
    if (currentTab === tabName) return;
    currentTab = tabName;

    // 切分頁時清掉側欄搜尋字串，避免「人物言行」分頁打的關鍵字
    // 殘留到「社會議題」分頁去搜尋議題名稱（反之亦然）。
    sidebarSearchInput.value = '';

    document.querySelectorAll('.main-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');

    if (tabName === 'editorTakes') {
        hideMajorEventsView();
        showEditorTakesView();
        const targetUrl = '/editor-takes/' + (pendingScrollToTakeId ? `#take-${pendingScrollToTakeId}` : '');
        if (window.location.pathname + window.location.hash !== targetUrl) {
            const newUrl = window.location.protocol + '//' + window.location.host + targetUrl;
            window.history.pushState({ path: newUrl }, '', newUrl);
            document.title = '站長觀點 | Polipoli 啪哩啪哩';
        }
        return;
    }
    if (tabName === 'majorEvents') {
        hideEditorTakesView();
        showMajorEventsView();
        if (window.location.pathname !== '/major-events/') {
            const newUrl = window.location.protocol + '//' + window.location.host + '/major-events/';
            window.history.pushState({ path: newUrl }, '', newUrl);
            document.title = '重大事件 | Polipoli 啪哩啪哩';
        }
        return;
    }

    restoreDefaultLayout();
    hideEditorTakesView();
    hideMajorEventsView();

    if (!preventReload) resetToLatest(true);
    else renderSidebar();
};

function restoreDefaultLayout() {
    containerEl.classList.remove('no-sidebar');
    feedContainer.style.display = '';
}
function showSpecialView(feedEl, title, loadFn) {
    containerEl.classList.add('no-sidebar');
    feedContainer.style.display = 'none';
    statDashboard.style.display = 'none';
    loader.classList.remove('visible');
    endMessage.style.display = 'none';
    feedTitle.textContent = title;
    feedEl.style.display = 'block';
    loadFn();
}
function showEditorTakesView() { showSpecialView(editorTakesFeedEl, '🗣️ 站長觀點', loadEditorTakesFeed); }
function hideEditorTakesView() { editorTakesFeedEl.style.display = 'none'; }
function showMajorEventsView() { showSpecialView(majorEventsFeedEl, '🗞️ 重大事件', loadMajorEventsFeed); }
function hideMajorEventsView() { majorEventsFeedEl.style.display = 'none'; }

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
    const container = editorTakesFeedEl;
    container.innerHTML = '<div class="empty-note">案卷調閱中...</div>';

    const { data: takes, error } = await supabase.from('editor_takes')
        .select(`
            id, title, content, created_at,
            editor_take_politician_map ( politician_id, politicians ( name ) ),
            editor_take_event_map ( event_id, events ( quote, date ) ),
            editor_take_major_event_map ( major_event_id, major_events ( title ) ),
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
            `<span class="info-tag">${escapeHtmlClient(m.politicians.name)}</span>`).join('');
        const eventTags = (t.editor_take_event_map || []).filter(m => m.events?.quote).map(m =>
            `<span class="info-tag issue-tag">「${escapeHtmlClient(m.events.quote)}」${m.events.date ? `（${escapeHtmlClient(m.events.date)}）` : ''}</span>`).join('');
        const majorEventTags = (t.editor_take_major_event_map || []).filter(m => m.major_events?.title).map(m =>
            `<a href="/major-events/#event-${m.major_event_id}" data-nav="majorEventLink" data-id="${m.major_event_id}" class="info-tag issue-tag">🗞️ ${escapeHtmlClient(m.major_events.title)}</a>`).join('');
        const visibleComments = (t.editor_take_comments || []).filter(c => !c.is_hidden)
            .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

        return `
        <article class="event-card editor-take-card" id="editor-take-${t.id}">
            <div class="tag-row">
                <span class="editor-take-badge">🗣️ 站長觀點</span>
                <span class="meta-tag">📅 ${escapeHtmlClient((t.created_at || '').slice(0, 10))}</span>
                ${polTags}${eventTags}${majorEventTags}
            </div>
            <h3 class="event-quote">${escapeHtmlClient(t.title)}</h3>
            <div class="event-context editor-take-content">${renderTakeContentHtml(t.content)}</div>
            ${renderEditorTakeCommentsHtml(t.id, visibleComments)}
        </article>`;
    }).join('');

    container.innerHTML = html;

    if (pendingScrollToTakeId) {
        const targetEl = document.getElementById(`editor-take-${pendingScrollToTakeId}`);
        if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            targetEl.classList.add('highlight-flash');
            setTimeout(() => targetEl.classList.remove('highlight-flash'), 2000);
        }
        pendingScrollToTakeId = null;
    }
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

/* ============================================================
   重大事件牆：跟人物言行的 events 資料庫完全分開的獨立內容
   ============================================================ */
async function loadMajorEventsFeed() {
    const container = majorEventsFeedEl;
    container.innerHTML = '<div class="empty-note">案卷調閱中...</div>';

    const { data, error } = await supabase.from('major_events')
        .select(`
            id, title, summary, content, updated_at,
            major_event_sources ( id, media_name, url ),
            editor_take_major_event_map ( editor_take_id, editor_takes ( title, is_visible ) )
        `)
        .eq('is_visible', true)
        .order('updated_at', { ascending: false });

    if (error) {
        container.innerHTML = '<div class="empty-note">載入失敗，請稍後再試。</div>';
        console.error(error);
        return;
    }

    if (!data || data.length === 0) {
        container.innerHTML = '<div class="analysis-empty">目前尚無重大事件專題。</div>';
        return;
    }

    container.innerHTML = `<div class="major-events-grid">${data.map(renderMajorEventCard).join('')}</div>`;

    if (pendingExpandMajorEventId) {
        const targetBtn = container.querySelector(`[data-toggle-major-event="${pendingExpandMajorEventId}"]`);
        const targetCard = targetBtn ? targetBtn.closest('.major-event-card') : null;
        if (targetCard) {
            targetCard.classList.add('expanded');
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        pendingExpandMajorEventId = null;
    }
}

function detectMentionedPoliticians(content) {
    if (!content) return [];
    // 長名字排前面：避免短名字剛好是另一個長名字的子字串時，還是讓比較精確的長名字先出現
    return cachePoliticians.filter(p => p.name && content.includes(p.name))
        .sort((a, b) => b.name.length - a.name.length);
}

function renderMajorEventCard(ev) {
    const mentioned = detectMentionedPoliticians(ev.content);
    const mentionsHtml = mentioned.length > 0 ? `
        <div class="major-event-mentions">
            <span class="major-event-mentions-label">📎 提及的政治人物：</span>
            ${mentioned.map(p => navAnchor({ type: 'politician', id: p.id, name: p.name, active: false, label: escapeHtmlClient(p.name), extraClass: 'info-tag' })).join('')}
        </div>` : '';

    const relatedTakes = (ev.editor_take_major_event_map || []).filter(m => m.editor_takes?.is_visible && m.editor_takes?.title);
    const relatedTakesHtml = relatedTakes.length > 0 ? `
        <div class="major-event-mentions">
            <span class="major-event-mentions-label">🗣️ 相關站長觀點：</span>
            ${relatedTakes.map(m => `<a href="/editor-takes/#take-${m.editor_take_id}" data-nav="editorTakeLink" data-id="${m.editor_take_id}" class="info-tag">${escapeHtmlClient(m.editor_takes.title)}</a>`).join('')}
        </div>` : '';

    let sourceLinks = '';
    (ev.major_event_sources || []).forEach(src => {
        sourceLinks += `<a href="${escapeHtmlClient(src.url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 ${src.media_name ? `[${escapeHtmlClient(src.media_name)}] ` : ''}查看原始來源</a>`;
    });

    return `
        <article class="major-event-card">
            <button type="button" class="major-event-summary" data-toggle-major-event="${ev.id}">
                <h3 class="major-event-title">${escapeHtmlClient(ev.title)}</h3>
                ${ev.summary ? `<p class="major-event-excerpt">${escapeHtmlClient(ev.summary)}</p>` : ''}
                <span class="major-event-meta">🔄 最後更新：${escapeHtmlClient((ev.updated_at || '').slice(0, 10))}</span>
                <span class="major-event-expand-hint">點擊展開全文 ▾</span>
            </button>
            <div class="major-event-body">
                <div class="major-event-content">${renderTakeContentHtml(ev.content)}</div>
                ${sourceLinks ? `<div class="major-event-sources">${sourceLinks}</div>` : ''}
                ${mentionsHtml}
                ${relatedTakesHtml}
            </div>
        </article>`;
}

/* ============================================================
   側欄索引
   ============================================================ */
function renderSidebar() {
    const title = document.getElementById('sidebar-title');
    const searchInput = sidebarSearchInput;
    searchContainer.style.display = 'block';

    title.textContent = '人物檔案索引';
    searchInput.placeholder = '輸入姓名搜尋人物...';

    renderSidebarSelects();

    if (searchInput.value.trim() !== '') filterSidebar();
    else renderSidebarButtons();
}

/* 人物／事件分類的下拉選單：跟上面的文字搜尋、下面的快速索引清單
   是三種並存的瀏覽方式，選了其中一個下拉選單就直接跳轉／就地篩選。 */
function renderSidebarSelects() {
    // 反推邏輯：如果議題那邊已經選了東西，人物選單就只列出「跟這個議題同時出現過」的人物；
    // 反過來，如果人物已經選了，議題選單也只列出跟這個人物有交集的議題。
    // 兩邊都沒選、或選的是自己這邊時，就顯示完整清單。
    const politicianOptionsSource = activeIssueId && issueToPoliticianIds[activeIssueId]
        ? cachePoliticians.filter(p => issueToPoliticianIds[activeIssueId].has(p.id))
        : cachePoliticians;

    const issueOptionsSource = activePoliticianId && politicianToIssueIds[activePoliticianId]
        ? cacheIssues.filter(i => politicianToIssueIds[activePoliticianId].has(i.id))
        : cacheIssues;

    let polOptions = `<option value="">👤 選擇政治人物...</option>`;
    polOptions += politicianOptionsSource.map(p =>
        `<option value="${p.id}" ${activePoliticianId === p.id ? 'selected' : ''}>${escapeHtmlClient(p.name)}</option>`
    ).join('');
    politicianSelect.innerHTML = polOptions;

    let issueOptions = `<option value="">📌 選擇事件分類...</option>`;
    issueOptions += issueOptionsSource.map(i =>
        `<option value="${i.id}" ${activeIssueId === i.id ? 'selected' : ''}>${escapeHtmlClient(i.name)}</option>`
    ).join('');
    issueSelect.innerHTML = issueOptions;
}

window.handlePoliticianSelect = function (val) {
    if (!val) { clearFilter('politician'); return; }
    const pol = cachePoliticians.find(p => p.id === val);
    if (pol) loadSpecificData('politician', pol.id, pol.name);
};

window.handleIssueSelect = function (val) {
    if (!val) { clearFilter('issue'); return; }
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
    let html = `<a class="catalog-card ${currentMode === 'latest' ? 'active' : ''}" style="justify-content:center;" href="/" data-nav="reset-latest"><span>✨ 綜合最新案卷</span></a>`;

    if (topFivePoliticians.length > 0) {
        html += `<div class="section-label">🔥 熱門追蹤人物</div>`;
        html += topFivePoliticians.map(p =>
            navAnchor({ type: 'politician', id: p.id, name: p.name, active: activePoliticianId === p.id, label: `👤 ${escapeHtmlClient(p.name)}` })
        ).join('');
    }

    const hardToTypePoliticians = cachePoliticians.filter(p => p.is_hard_to_type && !topFivePoliticians.some(tp => tp.id === p.id));

    if (hardToTypePoliticians.length > 0) {
        html += `<div class="section-label">📌 難檢字快速查</div>`;
        html += hardToTypePoliticians.map(p =>
            navAnchor({ type: 'politician', id: p.id, name: p.name, active: activePoliticianId === p.id, label: escapeHtmlClient(p.name) })
        ).join('');
    }

    catalogContainer.innerHTML = html;
}

window.filterSidebar = function () {
    const rawTerm = sidebarSearchInput.value.trim();
    const term = rawTerm.toLowerCase();

    if (!term) { renderSidebarButtons(); return; }

    const filtered = cachePoliticians.filter(p => p.name.toLowerCase().includes(term));
    if (filtered.length === 0) {
        catalogContainer.innerHTML = navAnchor({ type: 'politician', id: 'not-found', name: rawTerm, active: activePoliticianId === 'not-found', label: `👤 ${escapeHtmlClient(rawTerm)}` });
    } else {
        catalogContainer.innerHTML = filtered.map(p =>
            navAnchor({ type: 'politician', id: p.id, name: p.name, active: activePoliticianId === p.id, label: `👤 ${escapeHtmlClient(p.name)}` })
        ).join('');
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

/* ============================================================
   篩選核心：人物篩選、議題篩選各自獨立記錄，可以同時生效。
   所有進入點（下拉選單、快速索引清單、事件卡標籤、搜尋框、
   SSG 頁面 hydration、舊版網址參數）最後都走 setFilter/clearFilter
   → applyFilters 這條路，確保行為一致。
   ============================================================ */
function buildFeedTitle() {
    if (activePoliticianId === 'not-found') return `📂 查無「${activePoliticianName}」的相關案卷`;
    if (activePoliticianId && activeIssueId) return `📂 ${activePoliticianName} × 📌 ${activeIssueName} 的相關案卷`;
    if (activePoliticianId) return `📂 ${activePoliticianName} 的專屬案卷`;
    if (activeIssueId) return `📌 關於「${activeIssueName}」的相關案卷`;
    return '綜合案卷牆';
}

function buildPageTitle() {
    if (activePoliticianId && activePoliticianId !== 'not-found' && activeIssueId) {
        return `${activePoliticianName} × ${activeIssueName} 相關案卷 | Polipoli 啪哩啪哩`;
    }
    if (activePoliticianId && activePoliticianId !== 'not-found') return `${activePoliticianName} 爭議與言行紀錄 | Polipoli 啪哩啪哩`;
    if (activeIssueId) return `「${activeIssueName}」相關事件 | Polipoli 啪哩啪哩`;
    return 'Polipoli 啪哩啪哩 | 台灣政治人物爭議事件與雙標言行資料庫';
}

async function applyFilters(pushHistory = true) {
    const hasPol = !!activePoliticianId && activePoliticianId !== 'not-found';
    const isNotFound = activePoliticianId === 'not-found';
    const hasIssue = !!activeIssueId;

    currentMode = (hasPol || hasIssue || isNotFound) ? 'specific' : 'latest';
    currentTargetName = hasPol ? activePoliticianName : null;

    if (pushHistory) {
        const params = new URLSearchParams();
        if (activePoliticianId && !isNotFound) params.set('pol', activePoliticianId);
        if (hasIssue) params.set('issue', activeIssueId);
        const qs = params.toString();
        const newUrl = window.location.protocol + '//' + window.location.host + window.location.pathname + (qs ? `?${qs}` : '');
        window.history.pushState({ path: newUrl }, '', newUrl);
        document.title = buildPageTitle();
    }

    if (currentTab !== 'politicians') switchMainTab('politicians', true);

    sidebarSearchInput.value = hasPol ? (activePoliticianName || '') : '';

    nextOffset = 0;
    isFirstFetch = true;
    hasMoreData = true;
    feedContainer.innerHTML = '';
    endMessage.style.display = 'none';
    statDashboard.style.display = 'none';

    renderSidebar();
    feedTitle.textContent = buildFeedTitle();
    loader.classList.add('visible');

    if (isNotFound) {
        renderEvents([]);
        hasMoreData = false;
        loader.classList.remove('visible');
        endMessage.style.display = 'block';
        return;
    }

    if (!hasPol && !hasIssue) {
        // 兩個篩選都清空了：回到分頁載入的最新案卷牆
        loadLatestEvents();
        return;
    }

    const eventSelect = `
        *,
        event_politician_map ( politician_id, politicians ( name ) ),
        event_issue_map ( issue_id, issues ( name ) ),
        event_sources ( id, media_name, url, publish_date ),
        event_analysis ( content )
    `;

    let eventsData;

    if (hasPol && hasIssue) {
        // 交叉篩選：先分別查出兩邊各自符合的 event id，取交集，再抓完整資料
        const [polMapRes, issueMapRes] = await Promise.all([
            supabase.from('event_politician_map').select('event_id').eq('politician_id', activePoliticianId),
            supabase.from('event_issue_map').select('event_id').eq('issue_id', activeIssueId)
        ]);
        if (polMapRes.error || issueMapRes.error) {
            console.error('交叉篩選查詢失敗:', polMapRes.error || issueMapRes.error);
            loader.classList.remove('visible');
            return;
        }
        const issueEventIds = new Set((issueMapRes.data || []).map(r => r.event_id));
        const intersectIds = (polMapRes.data || []).map(r => r.event_id).filter(id => issueEventIds.has(id));

        if (intersectIds.length === 0) {
            eventsData = [];
        } else {
            const { data, error } = await supabase.from('events').select(eventSelect)
                .in('id', intersectIds).eq('is_visible', true);
            if (error) { console.error('交叉篩選資料載入失敗:', error); loader.classList.remove('visible'); return; }
            eventsData = data;
        }
    } else if (hasPol) {
        const { data, error } = await supabase.from('event_politician_map').select(`events!inner ( ${eventSelect} )`)
            .eq('politician_id', activePoliticianId).eq('events.is_visible', true);
        if (error) { console.error('人物篩選資料載入失敗:', error); loader.classList.remove('visible'); return; }
        eventsData = data.map(item => item.events);
    } else {
        const { data, error } = await supabase.from('event_issue_map').select(`events!inner ( ${eventSelect} )`)
            .eq('issue_id', activeIssueId).eq('events.is_visible', true);
        if (error) { console.error('議題篩選資料載入失敗:', error); loader.classList.remove('visible'); return; }
        eventsData = data.map(item => item.events);
    }

    eventsData.sort((a, b) => new Date(b.date || '1970-01-01') - new Date(a.date || '1970-01-01'));

    if (hasPol && eventsData.length > 0) {
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

    handleDataResponse(eventsData, null, '篩選案卷', true);
}

window.loadSpecificData = function (type, id, name, pushHistory = true) {
    if (type === 'politician') { activePoliticianId = id; activePoliticianName = name; }
    else { activeIssueId = id; activeIssueName = name; }
    applyFilters(pushHistory);
};

function clearFilter(type) {
    if (type === 'politician') { activePoliticianId = null; activePoliticianName = null; }
    else { activeIssueId = null; activeIssueName = null; }
    applyFilters(true);
}

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
            navAnchor({ type: 'issue', id: m.issue_id, name: m.issues.name, active: false, label: escapeHtmlClient(m.issues.name), extraClass: 'info-tag issue-tag' })
        ).join('') || '';

        const polTags = e.event_politician_map?.filter(m => m.politicians?.name && m.politicians.name !== currentTargetName).map(m =>
            navAnchor({ type: 'politician', id: m.politician_id, name: m.politicians.name, active: false, label: escapeHtmlClient(m.politicians.name), extraClass: 'info-tag' })
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
                ${renderImpactBox('對人民的影響', '💥', e.people_impact, e.people_impact_score)}
                ${renderImpactBox('對國安的影響', '🛡️', e.national_security_impact, e.national_impact_score, 'event-impact-security')}
                ${analysisContent ? `<div class="site-comment"><div class="site-comment-header"><span class="analysis-badge">⚠️ 觀點分析</span><strong>站長點評</strong></div><p>${escapeHtmlClient(analysisContent)}</p></div>` : ''}
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
    if (!force && currentMode === 'latest' && nextOffset === 0 && !activePoliticianId && !activeIssueId) return;

    activePoliticianId = null;
    activePoliticianName = null;
    activeIssueId = null;
    activeIssueName = null;
    applyFilters(true);
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
