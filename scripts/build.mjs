import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');

// 沿用 app.js 裡同一組 anon key（本來就是公開的，Cloudflare Pages 環境變數可覆蓋）
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ymrpsmrxnoyypayzujlm.supabase.co';
const ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InltcnBzbXJ4bm95eXBheXp1amxtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMwNTYyMzcsImV4cCI6MjA5ODYzMjIzN30.Mp8K310jjvKUkKQszs5VaA8GwuJUzQTv3PyXfP7ZdKU';
const SITE_URL = (process.env.SITE_URL || 'https://polipoli.cc').replace(/\/$/, '');

const supabase = createClient(SUPABASE_URL, ANON_KEY);

function slugify(name) {
    // 直接使用原始中文當資料夾名稱，讓 wrangler 自行處理 URL 編碼
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
    const [{ data: politicians, error: pErr }, { data: issues, error: iErr }, { data: events, error: eErr }] = await Promise.all([
        supabase.from('politicians').select('*').eq('is_visible', true).order('name'),
        supabase.from('issues').select('*').eq('is_visible', true).order('name'),
        supabase.from('events').select(`
            *,
            event_politician_map ( politician_id, politicians ( name ) ),
            event_issue_map ( issue_id, issues ( name ) ),
            event_sources ( id, media_name, url, publish_date )
        `).eq('is_visible', true).order('date', { ascending: false })
    ]);

    if (pErr) throw pErr;
    if (iErr) throw iErr;
    if (eErr) throw eErr;

    return { politicians: politicians || [], issues: issues || [], events: events || [] };
}

function renderImpactBarSSR(label, icon, score) {
    if (score === null || score === undefined || score === '') return '';
    const value = Math.min(100, Math.max(0, parseInt(score)));
    const level = value <= 20 ? 1 : value <= 40 ? 2 : value <= 60 ? 3 : value <= 80 ? 4 : 5;
    return `
        <div class="impact-bar-item">
            <span class="impact-bar-label">${icon} ${label}<span class="impact-bar-score">${value}</span></span>
            <div class="impact-bar-track">
                <div class="impact-bar-fill level-${level}" style="width: ${value}%"></div>
            </div>
        </div>`;
}

function renderEventCardSSR(e) {
    const issueTags = (e.event_issue_map || []).filter(m => m.issues?.name).map(m =>
        `<span class="info-tag issue-tag" onclick="loadSpecificData('issue', '${m.issue_id}', '${escapeHtml(m.issues.name)}')">📌 ${escapeHtml(m.issues.name)}</span>`
    ).join('');

    const polTags = (e.event_politician_map || []).filter(m => m.politicians?.name).map(m =>
        `<span class="info-tag" onclick="loadSpecificData('politician', '${m.politician_id}', '${escapeHtml(m.politicians.name)}')">👤 ${escapeHtml(m.politicians.name)}</span>`
    ).join('');

    const likesCount = e.likes_count || 0;

    let sourceLinks = '';
    (e.event_sources || []).forEach(src => {
        sourceLinks += `<a href="${escapeHtml(src.url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 [${escapeHtml(src.media_name)}] 查看原始來源</a>`;
    });
    if (!sourceLinks && e.source_url) {
        sourceLinks = `<a href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer" class="source-link">🔗 查看原始新聞來源</a>`;
    }

    const hasImpactScore = (e.people_impact_score !== null && e.people_impact_score !== undefined) ||
                            (e.national_impact_score !== null && e.national_impact_score !== undefined);
    const impactBarsHtml = hasImpactScore ? `
        <div class="impact-bars">
            ${renderImpactBarSSR('對人民影響', '👥', e.people_impact_score)}
            ${renderImpactBarSSR('對國家影響', '🛡️', e.national_impact_score)}
        </div>` : '';

    return `
        <article class="event-card">
            <div class="tag-row">
                <span class="meta-tag">📅 ${escapeHtml(e.date || '日期未明')}</span>
                ${polTags}
                ${issueTags}
            </div>
            <h3 class="event-quote">「${escapeHtml(e.quote)}」</h3>
            ${impactBarsHtml}
            <div class="event-context">${escapeHtml(e.context) || '無詳細脈絡說明。'}</div>
            ${e.people_impact ? `<div class="event-impact"><strong>💥 對人民的影響</strong><p>${escapeHtml(e.people_impact)}</p></div>` : ''}
            ${e.national_security_impact ? `<div class="event-impact event-impact-security"><strong>🛡️ 對國安的影響</strong><p>${escapeHtml(e.national_security_impact)}</p></div>` : ''}
            <div class="event-actions" style="display:flex;justify-content:space-between;flex-direction:row;align-items:flex-end;">
                <div class="like-container">
                    <button class="like-btn" onclick="toggleLike('${e.id}', this)">
                        <svg viewBox="0 0 24 24"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                        <span class="like-count">${likesCount}</span>
                    </button>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">${sourceLinks}</div>
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
                    "ratingValue": e.severity,
                    "bestRating": "5",
                    "worstRating": "1"
                },
                "author": { "@type": "Organization", "name": "Polipoli 啪哩啪哩" }
            }
        }))
    };
    return JSON.stringify(schemaData);
}

function renderPage({ title, description, ogTitle, ogDescription, canonicalPath, eventsHtml, schemaJson, hydrationScript }) {
    const template = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf-8');
    let html = template;

    html = html.replace(/<title>.*?<\/title>/s, `<title>${escapeHtml(title)}</title>`);
    html = html.replace(/<meta name="description" content=".*?">/s, `<meta name="description" content="${escapeHtml(description)}">`);
    html = html.replace(/<meta property="og:title" content=".*?">/s, `<meta property="og:title" content="${escapeHtml(ogTitle)}">`);
    html = html.replace(/<meta property="og:description" content=".*?">/s, `<meta property="og:description" content="${escapeHtml(ogDescription)}">`);
    html = html.replace('<link rel="stylesheet" href="./style.css">', '<link rel="stylesheet" href="/style.css">');
    html = html.replace('<link rel="preconnect"', `<link rel="canonical" href="${SITE_URL}${canonicalPath}">\n    <link rel="preconnect"`);
    html = html.replace('<div id="events-feed"></div>', `<div id="events-feed">${eventsHtml}</div>`);
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

    // 複製後台管理面板檔案（先前遺漏，導致 SSG 上線後 admin 後台無法訪問）
    ['admin.html', 'admin.css', 'admin.js'].forEach(f => {
        const src = path.join(ROOT, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT_DIR, f));
    });

    const { politicians, issues, events } = await fetchAll();
    const sitemapUrls = [`${SITE_URL}/`];

    // 首頁：最新事件
    const latestEvents = events.slice(0, 30);
    const homeHtml = renderPage({
        title: 'Polipoli 啪哩啪哩 | 台灣政治人物爭議事件與雙標言行資料庫',
        description: '專注記錄台灣政治人物言行、失言與重大社會議題。透過人物標籤快速檢驗雙標言論，提供完整的新聞脈絡與爭議事件懶人包。',
        ogTitle: 'Polipoli 啪哩啪哩 | 政治人物言行審查資料庫',
        ogDescription: '幫你記住政治人物說過的話。快速檢驗雙標言論，追蹤熱門人物的事件與爭議。',
        canonicalPath: '/',
        eventsHtml: latestEvents.map(renderEventCardSSR).join(''),
        schemaJson: buildSchema(latestEvents),
        hydrationScript: ''
    });
    fs.writeFileSync(path.join(OUT_DIR, 'index.html'), homeHtml);

    // 人物專屬頁
    for (const p of politicians) {
        const relatedEvents = events.filter(e => (e.event_politician_map || []).some(m => m.politician_id === p.id));
        if (relatedEvents.length === 0) continue;

        const slug = slugify(p.name);
        const dir = path.join(OUT_DIR, 'politician', slug);
        fs.mkdirSync(dir, { recursive: true });

        const html = renderPage({
            title: `${p.name} 爭議與言行紀錄 | Polipoli 啪哩啪哩`,
            description: `完整收錄 ${p.name} 的爭議事件、失言紀錄與相關新聞脈絡，共 ${relatedEvents.length} 筆事件。`,
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

    // sitemap.xml
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls.map(u => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>`;
    fs.writeFileSync(path.join(OUT_DIR, 'sitemap.xml'), sitemap);

    // robots.txt
    fs.writeFileSync(path.join(OUT_DIR, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);

    console.log(`✅ 完成：${politicians.length} 位人物、${issues.length} 個議題、${events.length} 筆事件`);
    console.log(`✅ 產生 ${sitemapUrls.length} 個靜態頁面於 /dist`);
}

main().catch(err => {
    console.error('❌ Build 失敗:', err);
    process.exit(1);
});
