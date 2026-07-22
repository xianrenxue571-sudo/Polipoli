import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

// 沿用 app.js 裡同一組 anon key（本來就是公開的，部署環境變數可覆蓋）
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const SITE_URL = (process.env.SITE_URL || 'https://polipoli.cc').replace(/\/$/, '');

const supabase = createClient(SUPABASE_URL, ANON_KEY);

function slugify(name) {
    // 直接使用原始中文當資料夾名稱，讓部署平台自行處理 URL 編碼，
    // 避免預先 encodeURIComponent 再被上傳工具二次編碼，造成雙重編碼 404
    return String(name).trim();
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function fetchAll() {
    const [
        { data: politicians, error: pErr },
        { data: issues, error: iErr },
        { data: events, error: eErr },
        { data: editorTakes, error: etErr },
        { data: majorEvents, error: meErr }
    ] = await Promise.all([
        supabase.from('politicians').select('*').eq('is_visible', true).order('name'),
        supabase.from('issues').select('*').eq('is_visible', true).order('name'),
        supabase.from('events').select(`
            *,
            event_politician_map ( politician_id, politicians ( name ) ),
            event_issue_map ( issue_id, issues ( name ) ),
            event_sources ( id, media_name, url, publish_date ),
            event_analysis ( content )
        `).eq('is_visible', true).order('date', { ascending: false }),
        supabase.from('editor_takes').select(`
            id, title, content, created_at,
            editor_take_politician_map ( politician_id, politicians ( name ) ),
            editor_take_event_map ( event_id, events ( quote, date ) ),
            editor_take_comments ( id, author_name, content, created_at, is_hidden )
        `).eq('is_visible', true).order('created_at', { ascending: false }),
        supabase.from('major_events').select(`
            id, title, summary, content, created_at,
            major_event_sources ( id, media_name, url )
        `).eq('is_visible', true).order('created_at', { ascending: false })
    ]);

    if (pErr) throw pErr;
    if (iErr) throw iErr;
    if (eErr) throw eErr;
    if (etErr) throw etErr;
    if (meErr) throw meErr;

    return {
        politicians: politicians || [],
        issues: issues || [],
        events: events || [],
        editorTakes: editorTakes || [],
        majorEvents: majorEvents || []
    };
}

function renderTakeContentHtmlSSR(raw) {
    const escaped = escapeHtml(raw || '');
    const withBold = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const paragraphs = withBold
        .split(/\n{2,}/)
        .map(p => p.trim())
        .filter(Boolean)
        .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
        .join('');
    return paragraphs || `<p>${withBold}</p>`;
}

function renderEditorTakeCommentsHtmlSSR(takeId, comments) {
    const list = (comments || []).map(c => `
        <div class="comment-item" id="comment-${c.id}">
            <div class="comment-item-header">
                <span class="comment-author">🙋 ${escapeHtml(c.author_name || '匿名讀者')}</span>
                <span class="comment-date">${escapeHtml((c.created_at || '').slice(0, 10))}</span>
            </div>
            <p class="comment-content">${escapeHtml(c.content)}</p>
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
                <textarea class="comment-content-input" id="comment-content-${takeId}" maxlength="500" placeholder="留下你的看法（最多 500 字）"></textarea>
                <button class="btn-comment-submit" onclick="submitTakeComment('${takeId}')">送出留言</button>
            </div>
        </div>`;
}

function renderEditorTakesFeedSSR(takes) {
    let html = '<div class="analysis-disclaimer">⚠️ 以下內容為「站長觀點」，是站長個人的主觀想法與評論，並非本站爭議事件資料庫查證後的事實認定，請自行判斷參考。</div>';

    if (!takes || takes.length === 0) {
        return html + '<div class="analysis-empty">目前尚無站長觀點。</div>';
    }

    html += takes.map(t => {
        const polTags = (t.editor_take_politician_map || []).filter(m => m.politicians?.name).map(m =>
            `<span class="info-tag">${escapeHtml(m.politicians.name)}</span>`
        ).join('');
        const eventTags = (t.editor_take_event_map || []).filter(m => m.events?.quote).map(m =>
            `<span class="info-tag issue-tag">「${escapeHtml(m.events.quote)}」${m.events.date ? `（${escapeHtml(m.events.date)}）` : ''}</span>`
        ).join('');
        const visibleComments = (t.editor_take_comments || []).filter(c => !c.is_hidden)
            .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));

        return `
        <article class="event-card editor-take-card">
            <div class="tag-row">
                <span class="editor-take-badge">🗣️ 站長觀點</span>
                <span class="meta-tag">📅 ${escapeHtml((t.created_at || '').slice(0, 10))}</span>
                ${polTags}
                ${eventTags}
            </div>
            <h3 class="event-quote">${escapeHtml(t.title)}</h3>
            <div class="event-context editor-take-content">${renderTakeContentHtmlSSR(t.content)}</div>
            ${renderEditorTakeCommentsHtmlSSR(t.id, visibleComments)}
        </article>`;
    }).join('');

    return html;
}

function detectMentionedPoliticiansSSR(content, politicians) {
    if (!content) return [];
    const found = politicians.filter(p => p.name && content.includes(p.name));
    return found.sort((a, b) => b.name.length - a.name.length);
}

function renderMajorEventCardSSR(ev, politicians) {
    const mentioned = detectMentionedPoliticiansSSR(ev.content, politicians);
    const mentionsHtml = mentioned.length > 0 ? `
        <div class="major-event-mentions">
            <span class="major-event-mentions-label">📎 提及的政治人物：</span>
            ${mentioned.map(p => navAnchorSSR('politician', p.id, p.name, escapeHtml(p.name), 'info-tag')).join('')}
        </div>` : '';

    let sourceLinks = '';
    (ev.major_event_sources || []).forEach(src => {
        sourceLinks += `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 ${src.media_name ? `[${escapeHtml(src.media_name)}] ` : ''}查看原始來源</a>`;
    });

    return `
        <article class="major-event-card">
            <button type="button" class="major-event-summary" data-toggle-major-event="${ev.id}">
                <h3 class="major-event-title">${escapeHtml(ev.title)}</h3>
                ${ev.summary ? `<p class="major-event-excerpt">${escapeHtml(ev.summary)}</p>` : ''}
                <span class="major-event-expand-hint">點擊展開全文 ▾</span>
            </button>
            <div class="major-event-body">
                <div class="major-event-content">${renderTakeContentHtmlSSR(ev.content)}</div>
                ${sourceLinks ? `<div class="major-event-sources">${sourceLinks}</div>` : ''}
                ${mentionsHtml}
            </div>
        </article>`;
}

function renderMajorEventsFeedSSR(majorEvents, politicians) {
    if (!majorEvents || majorEvents.length === 0) {
        return '<div class="analysis-empty">目前尚無重大事件專題。</div>';
    }
    return `<div class="major-events-grid">${majorEvents.map(ev => renderMajorEventCardSSR(ev, politicians)).join('')}</div>`;
}

function renderImpactMiniBarSSR(score) {
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

function renderImpactBoxSSR(label, icon, text, score, extraClass) {
    if (!text && !score) return '';
    return `
        <div class="event-impact ${extraClass || ''}">
            <div class="event-impact-header">
                <strong>${icon} ${label}</strong>
                ${renderImpactMiniBarSSR(score)}
            </div>
            ${text ? `<p>${escapeHtml(text)}</p>` : ''}
        </div>`;
}

function navAnchorSSR(type, id, name, label, extraClass) {
    const href = type === 'politician'
        ? `/politician/${encodeURIComponent(name)}/`
        : `/issue/${encodeURIComponent(name)}/`;
    return `<a class="${extraClass}" href="${href}" data-nav="${type}" data-id="${escapeHtml(id)}" data-name="${escapeHtml(name)}">${label}</a>`;
}

function parseContextLinksSSR(text) {
    if (!text) return '無詳細脈絡說明。';
    const escaped = escapeHtml(text);
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escaped.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer" class="source-link" style="display:inline;">🔗 參考連結</a>');
}

function renderEventCardSSR(e) {
    const issueTags = (e.event_issue_map || []).filter(m => m.issues?.name).map(m =>
        navAnchorSSR('issue', m.issue_id, m.issues.name, escapeHtml(m.issues.name), 'info-tag issue-tag')
    ).join('');

    const polTags = (e.event_politician_map || []).filter(m => m.politicians?.name).map(m =>
        navAnchorSSR('politician', m.politician_id, m.politicians.name, escapeHtml(m.politicians.name), 'info-tag')
    ).join('');

    const likesCount = e.likes_count || 0;
    const analysisContent = Array.isArray(e.event_analysis) ? e.event_analysis[0]?.content : e.event_analysis?.content;

    let sourceLinks = '';
    (e.event_sources || []).forEach(src => {
        sourceLinks += `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 [${escapeHtml(src.media_name)}] 查看原始來源</a>`;
    });
    if (!sourceLinks && e.source_url) {
        sourceLinks = `<a href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 查看原始新聞來源</a>`;
    }

    return `
        <article class="event-card">
            <div class="tag-row">
                <span class="meta-tag">📅 ${escapeHtml(e.date || '日期未明')}</span>
                ${polTags}
                ${issueTags}
            </div>
            <h3 class="event-quote">「${escapeHtml(e.quote)}」</h3>
            <div class="event-context">${parseContextLinksSSR(e.context)}</div>
            ${e.response_summary ? `<div class="event-response">🗣️ 當事人回應：${escapeHtml(e.response_summary)}</div>` : ''}
            ${analysisContent ? `<div class="site-comment"><div class="site-comment-header"><span class="analysis-badge">⚠️ 觀點分析</span><strong>站長點評</strong></div><p>${escapeHtml(analysisContent)}</p></div>` : ''}
            ${renderImpactBoxSSR('對人民的影響', '💥', e.people_impact, e.people_impact_score)}
            ${renderImpactBoxSSR('對國安的影響', '🛡️', e.national_security_impact, e.national_impact_score, 'event-impact-security')}
            <div class="event-actions">
                <div class="like-container">
                    <button class="like-btn" data-like-id="${e.id}">
                        <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                        <span class="like-count">${likesCount}</span>
                    </button>
                </div>
                <div class="source-link-group">${sourceLinks}</div>
            </div>
        </article>`;
}

function buildSchema(events) {
    const schemaData = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "itemListElement": events.map((e, index) => ({
            "@type": "ListItem",
            "position": index + 1,
            "item": {
                "@type": "ClaimReview",
                "datePublished": e.date,
                "claimReviewed": e.quote,
                "reviewRating": {
                    "@type": "Rating",
                    "ratingValue": e.people_impact_score || 0,
                    "bestRating": "100",
                    "worstRating": "0"
                },
                "author": { "@type": "Organization", "name": "Polipoli 啪哩啪哩" }
            }
        }))
    };
    return JSON.stringify(schemaData);
}

function renderPage({ title, description, ogTitle, ogDescription, canonicalPath, eventsHtml, schemaJson, hydrationScript, viewMode = 'events', feedTitle }) {
    const template = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
    let html = template;

    html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`);
    html = html.replace(/<meta name="description" content=".*?">/s, `<meta name="description" content="${escapeHtml(description)}">`);
    html = html.replace(/<meta property="og:title" content=".*?">/s, `<meta property="og:title" content="${escapeHtml(ogTitle)}">`);
    html = html.replace(/<meta property="og:description" content=".*?">/s, `<meta property="og:description" content="${escapeHtml(ogDescription)}">`);
    html = html.replace('<link rel="stylesheet" href="./style.css">', '<link rel="stylesheet" href="/style.css">');
    html = html.replace('<link rel="preconnect"', `<link rel="canonical" href="${SITE_URL}${canonicalPath}">\n    <link rel="preconnect"`);

    if (viewMode === 'editorTakes' || viewMode === 'majorEvents') {
        // 站長觀點／重大事件頁：預設隱藏案卷牆與側欄，直接把 SSR 內容放進對應容器，
        // 讓爬蟲與沒有執行 JS 的使用者也能看到完整內容；app.js 載入後會依 hydration 旗標重新抓取即時資料覆蓋上去。
        html = html.replace('<div id="events-feed"></div>', '<div id="events-feed" style="display:none;"></div>');
        html = html.replace('<div class="container">', '<div class="container no-sidebar">');
        html = html.replace('<aside>', '<aside style="display:none;">');
        html = html.replace('<div id="stat-dashboard"></div>', '<div id="stat-dashboard" style="display:none;"></div>');

        if (viewMode === 'editorTakes') {
            html = html.replace('<div id="editor-takes-feed" style="display:none;"></div>', `<div id="editor-takes-feed" style="display:block;">${eventsHtml}</div>`);
            html = html.replace('class="main-tab-btn active" id="tab-politicians"', 'class="main-tab-btn" id="tab-politicians"');
            html = html.replace('class="main-tab-btn" id="tab-editorTakes"', 'class="main-tab-btn active" id="tab-editorTakes"');
        } else {
            html = html.replace('<div id="major-events-feed" style="display:none;"></div>', `<div id="major-events-feed" style="display:block;">${eventsHtml}</div>`);
            html = html.replace('class="main-tab-btn active" id="tab-politicians"', 'class="main-tab-btn" id="tab-politicians"');
            html = html.replace('class="main-tab-btn" id="tab-majorEvents"', 'class="main-tab-btn active" id="tab-majorEvents"');
        }
        if (feedTitle) {
            html = html.replace(/<h2 id="feed-title">.*?<\/h2>/s, `<h2 id="feed-title">${escapeHtml(feedTitle)}</h2>`);
        }
    } else {
        html = html.replace('<div id="events-feed"></div>', `<div id="events-feed">${eventsHtml}</div>`);
    }

    html = html.replace(
        '<script type="module" src="./app.js"></script>',
        `<script type="application/ld+json">${schemaJson}</script>\n    ${hydrationScript}\n    <script type="module" src="/app.js"></script>`
    );
    return html;
}

async function main() {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    // 複製靜態資源
    fs.copyFileSync(path.join(ROOT, 'style.css'), path.join(OUT_DIR, 'style.css'));
    fs.copyFileSync(path.join(ROOT, 'app.js'), path.join(OUT_DIR, 'app.js'));
    ['polipoli_favicon.png', 'polipoli_favicon_512x512.png', 'apple-touch-icon.png', 'polipoli_og_share_1024x1024.png'].forEach(f => {
        const src = path.join(ROOT, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
    });

    // 複製後台管理面板與關於本站頁面
    ['admin.html', 'admin.css', 'admin.js', 'about.html', 'feedback.html'].forEach(f => {
        const src = path.join(ROOT, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
    });

    const { politicians, issues, events, editorTakes, majorEvents } = await fetchAll();
    const sitemapUrls = [`${SITE_URL}/`];

    // 首頁：最新案卷
    const latestEvents = events.slice(0, 30);
    const homeHtml = renderPage({
        title: 'Polipoli 啪哩啪哩 | 台灣政治人物爭議事件與雙標言行資料庫',
        description: '專注記錄台灣政治人物言行、失言與重大社會議題。透過人物標籤快速檢驗雙標言論，提供完整的新聞脈絡與爭議事件懶人包。',
        ogTitle: 'Polipoli 啪哩啪哩檔案室 | 政治人物言行審查資料庫',
        ogDescription: '幫你記住政治人物說過的話。快速檢驗雙標言論，追蹤熱門人物的事件與爭議。',
        canonicalPath: '/',
        eventsHtml: latestEvents.map(renderEventCardSSR).join(''),
        schemaJson: buildSchema(latestEvents),
        // 不需要額外的計數變數：app.js 會直接數 DOM 裡目前渲染了幾張案卷卡片
        // 來決定接續抓取的起點，比另外維護一個計數變數更不容易兩邊對不上。
        hydrationScript: ''
    });
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), homeHtml);

    // 重大事件牆：跟人物言行的 events 資料表完全分開的獨立內容，
    // 卡片並排網格呈現，SSR 直接輸出完整內文供爬蟲索引，前端再用 JS 做展開/收合。
    {
        const dir = path.join(OUT_DIR, 'major-events');
        fs.mkdirSync(dir, { recursive: true });
        const html = renderPage({
            title: '重大事件 | Polipoli 啪哩啪哩',
            description: '持續追蹤的重大社會事件專題，如軍購案、食安弊案等延續性議題的完整脈絡整理。',
            ogTitle: '重大事件 | Polipoli 啪哩啪哩',
            ogDescription: '持續追蹤的重大社會事件專題整理。',
            canonicalPath: '/major-events/',
            eventsHtml: renderMajorEventsFeedSSR(majorEvents, politicians),
            schemaJson: buildSchema([]),
            hydrationScript: `<script>window.__SSG_MAJOR_EVENTS_PAGE = true;</script>`,
            viewMode: 'majorEvents',
            feedTitle: '🗞️ 重大事件'
        });
        fs.writeFileSync(path.join(dir, 'index.html'), html);
        sitemapUrls.push(`${SITE_URL}/major-events/`);
    }

    // 人物專屬頁
    for (const p of politicians) {
        const relatedEvents = events.filter(e => (e.event_politician_map || []).some(m => m.politician_id === p.id));
        if (relatedEvents.length === 0) continue;

        const slug = slugify(p.name);
        const dir = path.join(OUT_DIR, 'politician', slug);
        fs.mkdirSync(dir, { recursive: true });

        const html = renderPage({
            title: `${p.name} 爭議與言行紀錄 | Polipoli 啪哩啪哩`,
            description: `完整收錄 ${p.name} 的爭議事件、失言紀錄與相關新聞脈絡，共 ${relatedEvents.length} 筆案卷。`,
            ogTitle: `${p.name} 爭議與言行紀錄 | Polipoli 啪哩啪哩`,
            ogDescription: `完整收錄 ${p.name} 的爭議事件、失言紀錄與相關新聞脈絡。`,
            canonicalPath: `/politician/${encodeURIComponent(slug)}/`,
            eventsHtml: relatedEvents.map(renderEventCardSSR).join(''),
            schemaJson: buildSchema(relatedEvents),
            hydrationScript: `<script>window.__SSG_POLITICIAN_ID = ${JSON.stringify(p.id)}; window.__SSG_POLITICIAN_NAME = ${JSON.stringify(p.name)};</script>`
        });
        fs.writeFileSync(path.join(dir, 'index.html'), html);
        sitemapUrls.push(`${SITE_URL}/politician/${encodeURIComponent(slug)}/`);
    }

    // 議題專屬頁
    for (const i of issues) {
        const relatedEvents = events.filter(e => (e.event_issue_map || []).some(m => m.issue_id === i.id));
        if (relatedEvents.length === 0) continue;

        const slug = slugify(i.name);
        const dir = path.join(OUT_DIR, 'issue', slug);
        fs.mkdirSync(dir, { recursive: true });

        const html = renderPage({
            title: `「${i.name}」相關事件 | Polipoli 啪哩啪哩`,
            description: `收錄與「${i.name}」議題相關的政治人物爭議事件，共 ${relatedEvents.length} 筆。`,
            ogTitle: `「${i.name}」相關事件 | Polipoli 啪哩啪哩`,
            ogDescription: `收錄與「${i.name}」議題相關的政治人物爭議事件。`,
            canonicalPath: `/issue/${encodeURIComponent(slug)}/`,
            eventsHtml: relatedEvents.map(renderEventCardSSR).join(''),
            schemaJson: buildSchema(relatedEvents),
            hydrationScript: `<script>window.__SSG_ISSUE_ID = ${JSON.stringify(i.id)}; window.__SSG_ISSUE_NAME = ${JSON.stringify(i.name)};</script>`
        });
        fs.writeFileSync(path.join(dir, 'index.html'), html);
        sitemapUrls.push(`${SITE_URL}/issue/${encodeURIComponent(slug)}/`);
    }

    // 站長觀點頁
    {
        const dir = path.join(OUT_DIR, 'editor-takes');
        fs.mkdirSync(dir, { recursive: true });
        const html = renderPage({
            title: '站長觀點 | Polipoli 啪哩啪哩',
            description: '站長個人對台灣政治人物與時事的主觀想法與評論，與查證過的爭議事件資料庫明確區隔。',
            ogTitle: '站長觀點 | Polipoli 啪哩啪哩',
            ogDescription: '站長的主觀評論與想法，非事實查證內容。',
            canonicalPath: '/editor-takes/',
            eventsHtml: renderEditorTakesFeedSSR(editorTakes),
            schemaJson: buildSchema([]),
            hydrationScript: `<script>window.__SSG_EDITOR_TAKES_PAGE = true;</script>`,
            viewMode: 'editorTakes',
            feedTitle: '🗣️ 站長觀點'
        });
        fs.writeFileSync(path.join(dir, 'index.html'), html);
        sitemapUrls.push(`${SITE_URL}/editor-takes/`);
    }

    // sitemap.xml
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
    fs.writeFileSync(path.join(OUT_DIR, 'sitemap.xml'), sitemap);

    // robots.txt
    fs.writeFileSync(path.join(OUT_DIR, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

    console.log(`✅ 完成：${politicians.length} 位人物、${issues.length} 個議題、${events.length} 筆事件、${editorTakes.length} 篇站長觀點、${majorEvents.length} 篇重大事件`);
    console.log(`✅ 產生 ${sitemapUrls.length} 個靜態頁面於 /dist`);
}

main().catch(err => {
    console.error('❌ Build 失敗:', err);
    process.exit(1);
});
