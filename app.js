const express = require('express');
const axios = require('axios');
const netease = require('NeteaseCloudMusicApi');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 初始化数据库
const DB_DIR = process.env.PERSISTENT_PATH || '.';
const USER_DB = path.join(DB_DIR, 'users.json');
const getIp = (req) => req.headers['x-real-ip'] || req.ip || '116.228.89.233';

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

const COLLECTIVE_CONFIG = [
    { id: '20953761', type: '集体恰恰' },
    { id: '1827007005', type: '集体舞兔子舞' },
    { id: '349892', type: '集体舞16步' }
];

async function getRealId(input) {
    let str = input.trim();
    if (!str) return null;

    // 1. 如果输入本来就是纯数字 ID
    if (/^\d+$/.test(str)) return str;

    // 2. 尝试从字符串中提取 id=xxxx 这种格式 (适配电脑版链接)
    const idMatch = str.match(/[?&]id=(\d+)/);
    if (idMatch) return idMatch[1];

    // 3. 尝试从 /playlist/xxxx 这种格式提取 (适配部分手机分享链接)
    const pathMatch = str.match(/\/playlist\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    // 4. 处理短链接 (如 https://163cn.tv/xxxx)
    if (str.startsWith('http')) {
        try {
            // 禁止自动跳转，手动获取 location
            const res = await axios.get(str, { 
                maxRedirects: 5, 
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/04.1' }
            });
            const finalUrl = res.request.res.responseUrl || '';
            const finalMatch = finalUrl.match(/[?&]id=(\d+)/) || finalUrl.match(/\/playlist\/(\d+)/);
            return finalMatch ? finalMatch[1] : null;
        } catch (e) {
            return null;
        }
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

// 改进后的概率抽样：增加排除项
function pickTypeByWeight(weights, excludeType = null) {
    // 过滤掉权重为 0 的舞种，以及上一次刚跳过的舞种
    let entries = Object.entries(weights).filter(([type, w]) => w > 0 && type !== excludeType);
    
    // 保护逻辑：如果除了刚跳过的，其他都没歌了（entries为空），
    // 那只能打破不连续规则，或者尝试重新把刚跳过的选回来（如果没有其他选择的话）
    if (entries.length === 0) {
        entries = Object.entries(weights).filter(([_, w]) => w > 0);
        if (entries.length === 0) return null; // 真的全都没歌了
    }

    const totalWeight = entries.reduce((sum, [_, w]) => sum + w, 0);
    let random = Math.random() * totalWeight;
    for (const [type, weight] of entries) {
        if (random < weight) return type;
        random -= weight;
    }
    return entries[0][0];
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

// 修改获取歌单详情的接口
app.get('/api/playlist/info', async (req, res) => {
    try {
        const rawInput = req.query.id;
        if (!rawInput) return res.json({ success: false, message: '请输入链接' });

        // 重点：调用解析函数提取真实 ID
        const realId = await getRealId(rawInput);
        
        if (!realId) {
            return res.json({ success: false, message: '无法从链接中识别歌单ID' });
        }

        const result = await netease.playlist_track_all({ 
            id: realId, 
            cookie: req.query.cookie 
        });

        if (result.body.code !== 200) {
            return res.json({ success: false, message: '网易云返回错误: ' + result.body.code });
        }

        res.json({ 
            success: true, 
            songs: result.body.songs.map(s => ({ 
                id: s.id, 
                name: s.name, 
                ar: formatArtists(s), 
                dt: s.dt || s.duration 
            })) 
        });
    } catch (e) {
        console.error('导入报错:', e);
        res.json({ success: false, message: '解析失败，请检查歌单是否为公开' });
    }
});
// --- 1. 自有账号系统接口 ---

app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const users = getUsers();
        if (users[username]) return res.json({ success: false, message: '用户名已存在' });
        users[username] = { password: await bcrypt.hash(password, 10), neteaseCookie: '' };
        saveUsers(users);
        res.json({ success: true });
    } catch(e) { res.json({ success: false, message: '注册失败' }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const users = getUsers();
    const user = users[username];
    if (!user || !(await bcrypt.compare(password, user.password))) return res.json({ success: false, message: '账号或密码错误' });
    res.json({ success: true, neteaseCookie: user.neteaseCookie });
});

app.post('/api/auth/update-cookie', (req, res) => {
    const { username, cookie } = req.body;
    const users = getUsers();
    if (users[username]) { 
        users[username].neteaseCookie = cookie; 
        saveUsers(users); 
        res.json({ success: true }); 
    } else res.json({ success: false, message: '用户不存在' });
});


// 核心生成接口
app.post('/api/calculate', async (req, res) => {
    try {
        let { duration, cookie, requestedSongs = [], useDefaultFill = true, mode = 'sequential', weights = {} } = req.body;
        if(!cookie) return res.json({ success: false, message: '未检测到网易云登录状态' });

        let collectivePool = [];
        if (useDefaultFill) {
            const colRes = await netease.song_detail({ ids: COLLECTIVE_CONFIG.map(c => c.id).join(','), cookie, realIP: getIp(req) });
            collectivePool = (colRes.body.songs || []).map(s => {
                const cfg = COLLECTIVE_CONFIG.find(c => c.id == s.id);
                return { id: s.id, name: s.name, ar: formatArtists(s), dt: s.dt || s.duration, type: cfg.type };
            });
        }

        let requestPool = {};
        DEFAULT_PLAYLISTS.forEach(p => requestPool[p.name] = []);
        requestedSongs.forEach(s => { if (requestPool[s.type]) requestPool[s.type].push(s); });

        let baseData = [[],[],[],[],[],[],[]];
        if (useDefaultFill) {
            const responses = await Promise.all(DEFAULT_PLAYLISTS.map(p => netease.playlist_track_all({ id: p.id, cookie })));
            baseData = responses.map(r => shuffle([...(r.body.songs || [])]));
        }

        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        
        let basePointers = {}; 
        DEFAULT_PLAYLISTS.forEach(p => basePointers[p.name] = 0);
        
        let roundCounter = 0; 
        let lastType = null;
        let hasMore = true;

        while (currentMs < targetMs && hasMore) {
            hasMore = false;
            if (mode === 'weighted') {
                // --- 权重随机模式（带保护） ---
                // 传入 lastType 进行避让
                const typeName = pickTypeByWeight(weights, lastType); 
                if (!typeName) break;

                let song = findSong(typeName);
                if (song) {
                    addSong(song);
                    lastType = typeName; // 更新最后一次舞种
                    hasMore = true;

                    // 集体舞逻辑（集体舞本身就起到了打断连续的作用）
                    if (useDefaultFill && roundCounter >= 7 && collectivePool.length > 0 && currentMs < targetMs) {
                        const col = collectivePool.shift();
                        if (!usedIds.has(col.id)) { 
                            addSong(col); 
                            lastType = col.type; // 集体舞也作为 lastType
                            roundCounter = 0; 
                        }
                    }
                } else {
                    weights[typeName] = 0; // 该舞种彻底没歌了
                    hasMore = Object.values(weights).some(w => w > 0);
                }
            } else {
                // --- 严格顺序模式 ---
                // 原有的顺序模式自然保证了不会连续（0-1-2-3-4-5-6循环）
                for (let i = 0; i < 7; i++) {
                    const typeName = DEFAULT_PLAYLISTS[i].name;
                    let song = findSong(typeName);
                    if (song) { addSong(song); hasMore = true; }
                    if (currentMs >= targetMs) break;
                }
                if (useDefaultFill && collectivePool.length > 0 && currentMs < targetMs) {
                    const col = collectivePool.shift();
                    if (!usedIds.has(col.id)) { addSong(col); hasMore = true; }
                }
            }
        }
        function findSong(typeName) {
            if (requestPool[typeName]?.length > 0) return requestPool[typeName].shift();
            if (useDefaultFill) {
                const bIdx = DEFAULT_PLAYLISTS.findIndex(p => p.name === typeName);
                if (bIdx !== -1 && baseData[bIdx][basePointers[typeName]]) {
                    const raw = baseData[bIdx][basePointers[typeName]++];
                    return { id: raw.id, name: raw.name, ar: formatArtists(raw), dt: raw.dt || raw.duration, type: typeName };
                }
            }
            return null;
        }

        function addSong(song) {
            if (song && !usedIds.has(song.id)) {
                result.push(song);
                usedIds.add(song.id);
                currentMs += song.dt;
                // 只有正规舞计入 roundCounter
                if (!song.type.includes('集体')) roundCounter++;
            }
        }

        //     for (let i = 0; i < 7; i++) {
        //         const typeName = DEFAULT_PLAYLISTS[i].name;
        //         let song = null;
        //         if (requestPool[typeName]?.length > 0) { song = requestPool[typeName].shift(); hasMore = true; }
        //         else if (useDefaultFill && baseData[i][basePointers[i]]) {
        //             const raw = baseData[i][basePointers[i]++];
        //             song = { id: raw.id, name: raw.name, ar: formatArtists(raw), dt: raw.dt || raw.duration, type: typeName };
        //             hasMore = true;
        //         }
        //         if (song && !usedIds.has(song.id)) { result.push(song); usedIds.add(song.id); currentMs += song.dt; }
        //         if (currentMs >= targetMs) break;
        //     }
        //     // ---  插入一首集体舞 (分散编排：每轮结束后插一首) ---
        //     if (useDefaultFill && collectivePool.length > 0 && currentMs < targetMs) {
        //         const colSong = collectivePool.shift(); // 按顺序取出一首：恰恰 -> 兔子 -> 16步
        //         if (!usedIds.has(colSong.id)) {
        //             result.push(colSong);
        //             usedIds.add(colSong.id);
        //             currentMs += colSong.dt;
        //             hasMore = true; 
        //         }
        //     }
        // }
        // const trackIds = result.map(s => s.id).reverse().join(',');
        // const createRes = await netease.playlist_create({ name: `舞会_${new Date().toLocaleDateString()}`, cookie });
        // if (createRes.body.code !== 200) throw new Error(createRes.body.msg || '创建歌单失败');
        
        // const newId = createRes.body.id;
        // await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        // res.json({ success: true, songs: result, playlistId: newId });
        res.json({ success: true, songs: result });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/sync', async (req, res) => {
    try {
        const { songs, cookie } = req.body;
        if (!songs || songs.length === 0) throw new Error('歌曲列表为空');

        // 正序取 ID，然后 reverse，保持你原来的逻辑
        const trackIds = songs.map(s => s.id).reverse().join(',');
        
        const now = new Date();
        const dateStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
        const playlistName = `舞会_${dateStr}`; 
        
        const createRes = await netease.playlist_create({ 
            name: playlistName, 
            cookie 
        });
        
        const newId = createRes.body.id;
        await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        
        res.json({ success: true, playlistId: newId });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// 网易云接口
app.get('/api/login/key', async (req, res) => res.json((await netease.login_qr_key({ realIP: '116.228.89.233' })).body));
app.get('/api/login/create', async (req, res) => res.json((await netease.login_qr_create({ key: req.query.key, qrimg: true, realIP: '116.228.89.233' })).body));
app.get('/api/login/check', async (req, res) => res.json((await netease.login_qr_check({ key: req.query.key, realIP: '116.228.89.233' })).body));
app.get('/api/search', async (req, res) => {
    try {
        const result = await netease.cloudsearch({ keywords: req.query.keywords, limit: 15 });
        res.json({ success: true, data: result.body.result.songs || [] });
    } catch(e) { res.json({ success: false }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`V2 PRO Fixed Running`));
