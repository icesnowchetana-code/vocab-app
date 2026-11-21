# 霸總文背單字 vocab-app

用霸總言情故事學英文和日文單字。每一集劇情會嵌入 8 個單字，看完可以做測驗，也可以自動存進 Notion 單字庫。

線上網址：https://icesnowchetana-code.github.io/vocab-app/

## 架構說明

這個 APP 分成三塊，各自放在不同的地方：

```
你的手機／電腦（瀏覽器）
   霸總單字網頁 ── 放在 GitHub Pages，只有畫面，不放任何金鑰
        │
        │  帶著「通關密碼」去敲門
        ▼
Cloudflare Worker（後端，像一個代辦櫃台）
   ├─ /api/story  幫你去找 Anthropic，請 AI 寫一集劇情
   └─ /api/words  幫你把這一集的單字寫進 Notion
        │
        │  金鑰都鎖在這裡，網頁和使用者都看不到
        ▼
Anthropic（寫劇情的 AI）      Notion（你的單字庫）
```

### 為什麼要多一個「後端」

以前的版本，網頁會請你輸入 Anthropic 的 API key，然後由瀏覽器直接去找 Anthropic。
這樣 key 會存在每一台用過的裝置上，要給家人用就得把 key 交出去。

現在 key 只放在 Cloudflare Worker 裡。網頁只知道一組「通關密碼」，
密碼對了，Worker 才會代替你去呼叫 Anthropic 和 Notion。
密碼外流了可以隨時換，不用動到真正的金鑰。

### 三道保護

1. **只認自己的網頁**：Worker 只接受從 `https://icesnowchetana-code.github.io` 來的請求，別的網站來敲門會直接被拒絕（CORS）。
2. **要有通關密碼**：密碼不對，回覆「通關密碼錯誤」，不會往下做任何事。
3. **花費有上限**：用哪個 AI 模型、一次最多寫多長，都由 Worker 決定，網頁端改不了。

### 金鑰放在哪裡

| 名稱 | 用途 | 放在哪裡 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 呼叫 AI 寫劇情 | Cloudflare Worker 的 Secrets |
| `NOTION_TOKEN` | 寫入 Notion 單字庫 | Cloudflare Worker 的 Secrets |
| `APP_PASS` | 通關密碼 | Cloudflare Worker 的 Secrets |

這個 repo 裡**沒有**任何金鑰。本機開發用的 `worker/.dev.vars` 已列在 `.gitignore`，不會被上傳。

## 單字怎麼進 Notion

在網頁上勾選「看完每集自動存入 Notion 單字庫」的裝置，每看完一集就會把該集的單字送去 Notion。
這個開關預設是關的，而且只記在那一台裝置上，所以家人的手機不會動到單字庫。

寫入規則：

- **單字庫裡還沒有這個字** → 新增一筆。來源填「霸總單字」、熟悉度填「陌生」、出現次數填 1。
- **已經有這個字**（英文不分大小寫）→ 只做三件事：出現次數加 1、最後出現改成今天、劇集後面追加這次的來源。
  定義、例句、詞性、熟悉度都不會被改掉。
- **來源是多選**：如果這個字原本是從別的地方來的（例如手動、Readle、書），會保留原本的來源，再補上「霸總單字」。

| 語言 | Notion 單字庫 |
|---|---|
| 英文 | 🇬🇧 英文單字庫 |
| 日文 | 🇯🇵 日文單字庫 |

### 每集一頁的劇集庫

單字寫完之後，還會在「📺 霸總劇集」多建一頁：裡面是整集劇情（單字粗體、附中文）和這一集的單字表。
劇集頁和單字庫互相連結：從劇集頁可以點到每個單字，從單字的「出現的劇集」欄可以點回那一集。
平常看劇集清單就好（一集一列），要複習某個字再進單字庫。

劇集頁如果建失敗（例如連接沒有劇集庫的權限），不影響已經寫好的單字，網頁會顯示原因。

## 檔案說明

| 檔案 | 是什麼 |
|---|---|
| `index.html` | 整個網頁（畫面、樣式、程式都在這一個檔） |
| `worker/src/index.js` | 後端程式 |
| `worker/wrangler.toml` | 後端的部署設定（不含金鑰） |
| `worker/.dev.vars.example` | 本機金鑰設定檔的範本（空白的） |

## 常用操作

以下指令都在 `worker` 資料夾裡執行。

### 換通關密碼

```
npx wrangler secret put APP_PASS
```

輸入新密碼後按 Enter（輸入時畫面不會顯示字，是正常的）。換完後，每台裝置要在網頁上重新輸入一次新密碼。

### 換 Anthropic key 或 Notion token

```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put NOTION_TOKEN
```

### 改了後端程式之後重新部署

```
npx wrangler deploy
```

### 改了網頁之後更新線上版

把 `index.html` 的改動 push 到 GitHub 的 `main` 分支，GitHub Pages 大約一分鐘內會自動更新。

### 在自己的電腦上測試

1. 把 `worker/.dev.vars.example` 複製成 `worker/.dev.vars`，填入金鑰和一組測試用密碼。
2. 在 `worker` 資料夾執行 `npm install`，再執行 `npm run dev`，後端會開在 `http://127.0.0.1:8799`。
3. 用任何本機網頁伺服器開啟 `index.html`（網址要是 `localhost` 或 `127.0.0.1`），網頁會自動改打本機的後端。

## 常見狀況

| 看到的訊息 | 原因 | 怎麼處理 |
|---|---|---|
| 生成失敗：通關密碼錯誤 | 密碼打錯，或密碼換過了 | 回到設定重新輸入並儲存 |
| 存入 Notion 失敗：…shared with your integration | Notion 的「霸總單字」連接沒有該單字庫的權限 | 到 Notion 連接設定的「內容存取權限」把單字庫加回去 |
| 生成失敗：…credit balance… | Anthropic 帳戶餘額不足 | 到 Anthropic Console 儲值 |
| 劇情不見了 | 劇情存在各自的瀏覽器裡，換裝置或清除瀏覽資料就會消失 | 單字如果有開 Notion 開關，仍然在 Notion 裡 |
