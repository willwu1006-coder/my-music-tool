const express = require('express');
const axios = require('axios');
const netease = require('NeteaseCloudMusicApi');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const USER_DB = './users.json';
// 初始化数据库
if (!fs.existsSync(USER_DB)) fs.writeFileSync(USER_DB, JSON.stringify({}));

// 辅助函数：读写用户数据
const getUsers = () => JSON.parse(fs.readFileSync(USER_DB));
const saveUsers = (data) => fs.writeFileSync(USER_DB, JSON.stringify(data, null, 2));

// 1. 默认歌单（直接使用 ID，速度最快）
const DEFAULT_PLAYLISTS = [
    { name: "慢三", id: "8425345141" },
    { name: "平四", id: "8425653027" },
    { name: "伦巴", id: "8425693717" },
    { name: "并四", id: "8842144798" },
    { name: "快三", id: "8425599404" },
    { name: "慢四", id: "8425648233" },
    { name: "吉特巴", id: "8425582396" }
];

async function getRealId(input) {
    let str = input.trim();
    if (!str) return null;
    const directMatch = str.match(/id=(\d+)/);
    if (directMatch) return directMatch[1];
    if (/^\d+$/.test(str)) return str; // 如果本身就是纯数字 ID
    
    const urlMatch = str.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        try {
            // 增加到 10 秒超时
            const res = await axios.get(urlMatch[0], { maxRedirects: 5, timeout: 10000 });
            const finalMatch = (res.request.res.responseUrl || '').match(/id=(\d+)/);
            return finalMatch ? finalMatch[1] : null;
        } catch (e) { return null; }
    }
    return null;
}

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 【新】搜索接口
app.get('/api/search', async (req, res) => {
    try {
        const { keywords } = req.query;
        const result = await netease.cloudsearch({ keywords, limit: 12 });
        res.json({ success: true, data: result.body.result.songs || [] });
    } catch (e) { res.json({ success: false }); }
});

const formatArtists = (song) => {
    const list = song.ar || song.artists || [];
    return Array.isArray(list) ? list.map(a => a.name).join('/') : "未知歌手";
};

// 【新增】获取歌单详情接口
app.get('/api/playlist/info', async (req, res) => {
    try {
        let { id, cookie } = req.query;
        const realId = await getRealId(id); // 复用之前的 ID 解析逻辑
        if (!realId) return res.json({ success: false, message: '无效的歌单链接或ID' });

        const result = await netease.playlist_track_all({ id: realId, cookie });
        const songs = (result.body.songs || []).map(s => ({
            id: s.id,
            name: s.name,
            ar: formatArtists(s),
            dt: s.dt || s.duration
        }));
        res.json({ success: true, songs });
    } catch (e) {
        res.json({ success: false, message: '获取歌单失败' });
    }
});

// --- 1. 自有账号系统接口 ---

// 注册
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    if (users[username]) return res.json({ success: false, message: '用户名已存在' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    users[username] = { password: hashedPassword, neteaseCookie: '' };
    saveUsers(users);
    res.json({ success: true });
});

// 登录
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users[username];
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.json({ success: false, message: '账号或密码错误' });
    }
    res.json({ success: true, neteaseCookie: user.neteaseCookie });
});

// 更新网易云 Cookie 到账号
app.post('/api/auth/update-cookie', (req, res) => {
    const { username, cookie } = req.body;
    const users = getUsers();
    if (users[username]) {
        users[username].neteaseCookie = cookie;
        saveUsers(users);
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

app.post('/api/generate', async (req, res) => {
    try {
        let { duration, cookie, requestedSongs = [], useDefaultFill = true } = req.body;
        
        // 1. 整理用户标记池
        let requestPool = {};
        DEFAULT_PLAYLISTS.forEach(p => requestPool[p.name] = []);
        requestedSongs.forEach(s => {
            if (requestPool[s.type]) requestPool[s.type].push(s);
        });

        // 2. 如果开启了补充，获取底库
        let baseData = [[],[],[],[],[],[],[]];
        if (useDefaultFill) {
            const responses = await Promise.all(DEFAULT_PLAYLISTS.map(p => netease.playlist_track_all({ id: p.id, cookie })));
            baseData = responses.map(r => shuffle([...(r.body.songs || [])]));
        }

        // 3. 编排
        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        let basePointers = new Array(7).fill(0);
        let hasMore = true;

        while (currentMs < targetMs && hasMore) {
            hasMore = false;
            for (let i = 0; i < 7; i++) {
                const typeName = DEFAULT_PLAYLISTS[i].name;
                let song = null;

                if (requestPool[typeName] && requestPool[typeName].length > 0) {
                    song = requestPool[typeName].shift();
                    hasMore = true;
                } else if (useDefaultFill && baseData[i] && basePointers[i] < baseData[i].length) {
                    const raw = baseData[i][basePointers[i]++];
                    song = { id: raw.id, name: raw.name, ar: raw.ar.map(a=>a.name).join('/'), dt: raw.dt || raw.duration, type: typeName };
                    hasMore = true;
                }

                if (song && !usedIds.has(song.id)) {
                    result.push(song);
                    usedIds.add(song.id);
                    currentMs += song.dt;
                }
                if (currentMs >= targetMs) break;
            }
        }

        // 4. 同步到网易云
        const trackIds = result.map(s => s.id).reverse().join(',');
        const createRes = await netease.playlist_create({ name: `舞会_${new Date().toLocaleDateString()}`, cookie });
        await netease.playlist_tracks({ op: 'add', pid: createRes.body.id, tracks: trackIds, cookie });
        
        res.json({ success: true, songs: result, playlistId: createRes.body.id });
    } catch (e) { res.json({ success: false, message: e.message }); }
});


app.get('/api/login/key', async (req, res) => {
    try {
        const result = await netease.login_qr_key({
            // 随便找一个国内的城市 IP，例如上海
            realIP: '116.228.89.233' 
        });
        res.json(result.body);
    } catch (e) { res.json({ success: false }); }
});

// 2. 修改创建二维码的接口
app.get('/api/login/create', async (req, res) => {
    try {
        const result = await netease.login_qr_create({
            key: req.query.key,
            qrimg: true,
            realIP: '116.228.89.233' // 保持 IP 一致
        });
        res.json(result.body);
    } catch (e) { res.json({ success: false }); }
});

// 3. 修改检查状态的接口
app.get('/api/login/check', async (req, res) => {
    try {
        const result = await netease.login_qr_check({
            key: req.query.key,
            realIP: '116.228.89.233'
        });
        res.json(result.body);
    } catch (e) { res.json({ success: false }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`V2 PRO Fixed Running`));
