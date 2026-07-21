# Polipoli 啪哩啪哩｜檔案室主題重製版

沿用原站的完整功能（Supabase 資料層、SSG 建構、Cloudflare Worker 後台驗證、
人物／議題頁、分析紀錄、站長觀點與留言、按讚、無限捲動、後台審核與去重），
重新設計為「政治人物言行檔案室」視覺主題：牛皮紙底色、公文印章戳記、
測謊儀讀數造型的影響指數、卷夾撕紙頁首。

## 與原站的差異

| 項目 | 原站 | 本版 |
|---|---|---|
| 視覺定位 | 一般資訊網站風格 | 檔案室／案卷資料庫風格 |
| 配色 | 藍色系 | 牛皮紙 + 檔案櫃深綠 + 印泥紅 + 黃銅 |
| 字體 | 系統無襯線字 | Noto Serif TC（標題）＋等寬字（標籤/案號） |
| 影響指數呈現 | 一般進度條 | 測謊儀波形讀數造型 |
| 觀點／站長評論標記 | 一般徽章 | 旋轉印章戳記 |
| 功能 | — | 完全相同 |

後台（admin.html / admin.js）維持與原站相同的程式邏輯與 DOM 結構，
僅更換 admin.css 視覺樣式，確保審核牆、去重檢查、JSON 匯入、分析與
站長觀點管理等既有操作流程不受影響。

## 開發

```bash
npm install
SUPABASE_URL=... SUPABASE_ANON_KEY=... SITE_URL=https://polipoli.cc npm run build
npx wrangler deploy
```

`ADMIN_USER` / `ADMIN_PASSWORD` 需在 Cloudflare Worker 環境變數中設定，
用於保護 `/admin` 路徑。
