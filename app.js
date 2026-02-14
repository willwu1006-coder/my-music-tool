const express = require('express');
const axios = require('axios');
const netease = require('NeteaseCloudMusicApi');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const path = require('path');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const getIp = (req) => req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.ip || '116.228.89.233';

// 连接数据库 (Zeabur 环境变量)
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/dance_tool';
mongoose.connect(MONGO_URL)
  .then(() => console.log('✅ MongoDB 已连接'))
  .catch(err => console.error('❌ 数据库连接失败:', err));

// --- 定义模型 (替代原来的 users.json 和 rooms.json) ---

// 用户模型
const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    neteaseCookie: String
}));

// 协作房间模型 - 修改为最通用的 Array 类型
const Room = mongoose.model('Room', new mongoose.Schema({
    roomId: { type: String, unique: true },
    name: { type: String, default: '未命名共享歌单' },
    owner: String,
    songs: { type: Array, default: [] }, // 重点：直接设为 Array，不要写内部结构
    createdAt: { type: Date, default: Date.now }
}));

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

// 注册
app.post('/api/auth/register', async (req, res) => {
    try {
        const { username, password } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: '用户名已存在' });
    }
});

// 登录
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.json({ success: false, message: '账号或密码错误' });
    }
    res.json({ success: true, neteaseCookie: user.neteaseCookie });
});

// 更新网易云 Cookie
app.post('/api/auth/update-cookie', async (req, res) => {
    const { username, cookie } = req.body;
    await User.updateOne({ username }, { neteaseCookie: cookie });
    res.json({ success: true });
});



// 创建房间
app.post('/api/room/create', async (req, res) => {
    try {
        const { username } = req.body;
        const roomId = crypto.randomBytes(4).toString('hex');
        const newRoom = new Room({ roomId, owner: username, songs: [] });
        await newRoom.save();
        res.json({ success: true, roomId });
    } catch (e) { res.json({ success: false }); }
});

// 获取房间信息 (返回时按点赞数排序)
// 获取房间信息
app.get('/api/room/info', async (req, res) => {
    try {
        const { roomId } = req.query;
        // 使用 .lean() 可以让返回的对象更容易操作
        const room = await Room.findOne({ roomId }).lean();

        // 1. 检查房间是否存在
        if (!room) {
            return res.json({ success: false, message: '房间不存在' });
        }

        // 2. 检查 songs 是否存在且是数组 (重点修复)
        let songs = room.songs || [];
        
        // 3. 执行排序 (增加 likes 的默认值保护)
        songs.sort((a, b) => (b.likes || 0) - (a.likes || 0));
        
        // 4. 将排序后的歌重新放回对象
        room.songs = songs;

        res.json({ success: true, data: room });
    } catch (e) {
        console.error('获取房间信息失败:', e);
        res.json({ success: false, message: '服务器内部错误' });
    }
});

// 修改房间名
app.post('/api/room/update-name', async (req, res) => {
    const { roomId, name } = req.body;
    await Room.updateOne({ roomId }, { name });
    res.json({ success: true });
});

// 获取当前用户创建的所有房间
app.get('/api/room/my-rooms', async (req, res) => {
    try {
        const { username } = req.query;
        if (!username) return res.json({ success: false });

        // 查询 owner 为该用户的所有房间，按时间倒序排列，取最近 10 个
        const rooms = await Room.find({ owner: username })
                                .select('roomId name createdAt')
                                .sort({ createdAt: -1 })
                                .limit(10)
                                .lean();

        res.json({ success: true, rooms });
    } catch (e) {
        res.json({ success: false });
    }
});

// 删除协作房间
app.post('/api/room/delete', async (req, res) => {
    try {
        const { roomId, username } = req.body;
        // 只有房间的 owner（创建者）才有权删除
        const result = await Room.deleteOne({ roomId, owner: username });
        
        if (result.deletedCount > 0) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '无权删除或房间已失效' });
        }
    } catch (e) {
        res.json({ success: false, message: '删除失败' });
    }
});

// 点赞歌曲
app.post('/api/room/like', async (req, res) => {
    try {
        const { roomId, songId, username } = req.body;

        if (!username) return res.json({ success: false, message: '请先登录' });

        // 1. 先检查这首歌是否已经被该用户点赞过
        const roomCheck = await Room.findOne({ 
            roomId: roomId, 
            songs: { $elemMatch: { id: String(songId), likedBy: username } } 
        });

        if (roomCheck) {
            return res.json({ success: false, message: '您已经点过赞啦！' });
        }

        // 2. 执行更新：增加点赞数，并将用户名加入 likedBy 数组
        // 使用 $push 如果字段不存在会自动创建
        const result = await Room.updateOne(
            { roomId: roomId, "songs.id": String(songId) },
            { 
                $inc: { "songs.$.likes": 1 },
                $push: { "songs.$.likedBy": username }
            }
        );

        if (result.matchedCount > 0) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '找不到该歌曲' });
        }
    } catch (e) {
        console.error('点赞报错:', e);
        res.json({ success: false, message: '点赞失败' });
    }
});

app.post('/api/room/add', async (req, res) => {
    try {
        let { roomId, username, song } = req.body;

        // 1. 如果 song 莫名其妙变成了字符串，强行解析它
        if (typeof song === 'string') {
            try {
                // 处理可能存在的奇怪转义字符
                const cleanJson = song.replace(/\n/g, '').replace(/\+/g, '');
                song = JSON.parse(cleanJson);
            } catch (e) {
                console.error('JSON解析失败:', song);
            }
        }

        // 2. 手动提取字段，构建一个纯净的对象存入（这是解决 CastError 的终极方案）
        const songObject = {
            id: String(song.id || ''),
            name: String(song.name || '未知歌名'),
            ar: String(song.ar || '未知歌手'),
            dt: Number(song.dt || 0),
            type: String(song.type || '未知舞种'),
            addedBy: String(username || '匿名舞友'),
            likes: 0,
            likedBy: []
        };

        // 3. 执行更新
        const result = await Room.updateOne(
            { roomId: roomId },
            { $push: { songs: songObject } }
        );

        if (result.matchedCount > 0) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: '找不到该房间' });
        }
    } catch (e) {
        console.error('添加失败详细日志:', e);
        res.json({ success: false, message: '添加失败: ' + e.message });
    }
});


// 核心生成接口
app.post('/api/calculate', async (req, res) => {
    try {
        let { duration, cookie, requestedSongs = [], useDefaultFill = true, mode = 'sequential', weights = {} , roomId } = req.body;
        if(!cookie) return res.json({ success: false, message: '未检测到网易云登录状态' });
        
        let finalRequests = [...requestedSongs];
        
        // 重点：从数据库读取协作房间的歌曲
        if (roomId) {
        const room = await Room.findOne({ roomId }).lean();
        if (room && room.songs && Array.isArray(room.songs)) {
            // 按照点赞数降序排列
            const sortedRoomSongs = [...room.songs].sort((a, b) => (b.likes || 0) - (a.likes || 0));
            finalRequests = [...finalRequests, ...sortedRoomSongs];
        }
    }
        
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
        finalRequests.forEach(s => { 
            if (requestPool[s.type]) requestPool[s.type].push(s); 
        });

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
