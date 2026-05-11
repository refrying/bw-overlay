const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const Tail = require('tail').Tail;
const path = require('path');
const os = require('os');
const axios = require('axios');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let win, setupWin;
let API_KEY = store.get('apiKey') || '';
let hideTimer = null;
let hasActivated = false;

// --- 1. IPCハンドラの登録 (設定データの受け渡し) ---
ipcMain.handle('get-stored-data', () => {
  return {
    apiKey: store.get('apiKey') || '',
    selectedClient: store.get('selectedClient') || 'lunar',
    toggleKey: store.get('toggleKey') || 'Tab',
    accentColor: store.get('accentColor') || '#5555ff',
    chromaMode: store.get('chromaMode') || false,
    displayTime: store.get('displayTime') || 4
  };
});

// ショートカット登録関数
function registerMyShortcut(key) {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(key, () => {
      if (win) {
        if (win.isVisible()) {
          win.hide();
        } else {
          // showInactiveでマイクラのフォーカスを維持
          win.showInactive();
          if (hasActivated) win.setIgnoreMouseEvents(true);
        }
      }
    });
  } catch (e) {
    console.error("Shortcut registration failed:", e);
  }
}

function createWindow() {
  if (win) return; // 二重生成防止

  win = new BrowserWindow({
    width: 550, 
    height: 150,
    title: 'Seijika Overlay',
    icon: path.join(__dirname, 'icon.png'),
    alwaysOnTop: true, 
    transparent: true, 
    frame: false,
    resizable: false,
    skipTaskbar: true, // オーバーレイはタスクバーに出さない
    show: true, 
    focusable: false, // キーボードフォーカスを奪わない
    webPreferences: { 
      nodeIntegration: true, 
      contextIsolation: false 
    }
  });

  win.loadFile('index.html');
  win.setAlwaysOnTop(true, "screen-saver");

  // 起動時は移動可能。統計表示後は透過
  win.setIgnoreMouseEvents(false);
  hasActivated = false; 

  const savedKey = store.get('toggleKey') || 'Tab';
  registerMyShortcut(savedKey);
}

function createSetupWindow() {
  setupWin = new BrowserWindow({
    width: 450, 
    height: 650, 
    frame: true, 
    title: 'Seijika Overlay - Setup',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { 
      nodeIntegration: true, 
      contextIsolation: false 
    }
  });

  setupWin.loadFile('setup.html');

  // 【重要】設定画面を閉じたらアプリ全体を終了する
  setupWin.on('closed', () => {
    app.quit();
  });
}

// --- 2. 統計判定ロジック ---
const getStarColor = (s) => s<100?"#aaaaaa":s<200?"#ffffff":s<300?"#ffaa00":s<400?"#55ffff":s<500?"#00aa00":s<600?"#aa00aa":s<700?"#ff5555":s<800?"#ff55ff":s<900?"#5555ff":s<1000?"#00aa00":"#ffff55";
const getFKDRColor = (v) => v<1?"#aaaaaa":v<4?"#55ff55":v<10?"#ffff55":"#ff5555";
const getWLRColor = (v) => v<1?"#aaaaaa":v<2?"#ffffff":v<4?"#55ff55":v<7?"#55ffff":v<10?"#ffff55":"#ff5555";

function getRankColor(p) {
  if (!p) return "#aaaaaa";
  const r = p.newPackageRank || p.packageRank || "NONE";
  if (p.prefix?.includes("ADMIN")) return "#ff5555";
  if (p.monthlyPackageRank === "SUPERSTAR") return "#ffaa00"; 
  if (r.includes("MVP")) return "#55ffff";
  if (r.includes("VIP")) return "#55ff55";
  return "#aaaaaa";
}

// --- 3. 統計取得 (Mojang & Hypixel API) ---
async function getStats(name) {
  let res = { name, star: '?', fkdr: '0.0', wlr: '0.0', ws: 0, rankColor: '#aaa', starColor: '#aaa', fkdrColor: '#fff', wlrColor: '#fff', tag: '', tagColor: '' };
  try {
    const mojang = await axios.get(`https://api.mojang.com/users/profiles/minecraft/${name}`, { timeout: 2000 }).catch(() => null);
    if (!mojang || !mojang.data) {
      res.tag = "NICK"; 
      res.tagColor = "#ff55ff";
    } else {
      const uuid = mojang.data.id;
      const hypixel = await axios.get(`https://api.hypixel.net/player?key=${API_KEY}&uuid=${uuid}`, { timeout: 3000 }).catch(() => null);
      if (hypixel?.data?.player) {
        const p = hypixel.data.player;
        const bw = p.stats?.Bedwars || {};
        res.name = p.displayname || name;
        res.star = p.achievements?.bedwars_level || 0;
        res.fkdr = ((bw.final_kills_bedwars || 0) / (bw.final_deaths_bedwars || 1)).toFixed(1);
        res.wlr = ((bw.wins_bedwars || 0) / (bw.losses_bedwars || 1)).toFixed(1);
        res.ws = bw.winstreak || 0;
        res.starColor = getStarColor(res.star);
        res.fkdrColor = getFKDRColor(parseFloat(res.fkdr));
        res.wlrColor = getWLRColor(parseFloat(res.wlr));
        res.rankColor = getRankColor(p);
        if (res.ws > 0) res.tag = "WS";
      } else {
        res.tag = "NICK"; 
        res.tagColor = "#ff55ff";
      }
    }
    const altKeywords = ["alt", "voxerism", "tzi_", "ksyzi", "meow_", "Linh", "rave"];
    const isMatched = altKeywords.some(keyword => res.name.toLowerCase().includes(keyword.toLowerCase()));
    if (isMatched) {
      res.tag = "ALT";
      res.tagColor = "#ffffff";
    }
  } catch (e) {
    res.tag = "NICK";
    res.tagColor = "#ff55ff";
  }
  return res;
}

// --- 4. ログ監視 & ダイナミック表示 ---
function startLogging(type) {
  const home = os.homedir();
  let logPath = (type === 'blc') 
    ? path.join(home, 'AppData', 'Roaming', '.minecraft', 'logs', 'blclient', 'minecraft', 'latest.log')
    : path.join(home, '.lunarclient', 'profiles', 'lunar', '1.8', 'logs', 'latest.log');

  if (fs.existsSync(logPath)) {
    const tail = new Tail(logPath);
    tail.on("line", async (data) => {
      if (data.includes("ONLINE:")) {
        const names = data.split("ONLINE: ")[1].split(", ").map(n => n.trim().replace(/\[.*?\]/g, "").trim());
        const list = await Promise.all(names.map(getStats));
        
        if (win) {
          win.webContents.send('update-stats', list);
          win.setSize(550, Math.min(115 + (list.length * 39), 950));
          
          hasActivated = true;
          win.showInactive();
          win.setIgnoreMouseEvents(true);

          const displayMs = (store.get('displayTime') || 4) * 1000;
          if (hideTimer) clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            if (win) win.hide();
          }, displayMs);
        }
      }
    });
  }
}

// --- 5. プロセス通信 (保存ボタン押下時) ---
ipcMain.on('submit-api', (event, data) => {
  API_KEY = data.key.trim();
  store.set('apiKey', API_KEY);
  store.set('selectedClient', data.client);
  store.set('toggleKey', data.toggleKey);
  store.set('accentColor', data.accentColor);
  store.set('chromaMode', data.chromaMode);
  store.set('displayTime', data.displayTime);
  
  createWindow(); 
  startLogging(data.client);
  
  // 設定完了を通知（必要ならダイアログ等）
  console.log("Settings updated. Overlay is running.");
});

app.whenReady().then(createSetupWindow);

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});