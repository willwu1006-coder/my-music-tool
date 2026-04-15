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
    neteaseCookie: String,
    favorites: { type: [String], default: [] }
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

    // 1. 如果输入本身就是纯数字 ID
    if (/^\d+$/.test(str)) return str;

    // 2. 先尝试直接从这段文字中抠出带有 id= 的数字 (适配电脑版长链接)
    const idMatch = str.match(/[?&]id=(\d+)/);
    if (idMatch) return idMatch[1];

    // 3. 尝试直接从这段文字中抠出 /playlist/ 后的数字 (适配部分手机长链接)
    const pathMatch = str.match(/\/playlist\/(\d+)/);
    if (pathMatch) return pathMatch[1];

    // 4. 如果上面都没匹配到，说明可能是个短链接 (如 163cn.tv)
    // 重点：我们从这一堆杂乱文字中抠出 http 开头的 URL
    const urlMatch = str.match(/https?:\/\/[^\s/$.?#].[^\s]*/);
    if (urlMatch) {
        const url = urlMatch[0];
        try {
            // 请求这个链接，获取重定向后的真实地址
            const res = await axios.get(url, { 
                maxRedirects: 5, 
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 13)' }
            });
            const finalUrl = res.request.res.responseUrl || '';
            
            // 对重定向后的真实长链接再次进行 ID 匹配
            const finalMatch = finalUrl.match(/[?&]id=(\d+)/) || finalUrl.match(/\/playlist\/(\d+)/);
            return finalMatch ? finalMatch[1] : null;
        } catch (e) {
            console.error('短链解析失败:', e.message);
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


const formatArtists = (song) => {
    const list = song.ar || song.artists || [];
    return Array.isArray(list) ? list.map(a => a.name).join('/') : "未知歌手";
};
const getSongPic = (song) => {
    if (!song) return "";
    // 兼容 al (歌单接口) 或 album (搜索接口)
    const album = song.al || song.album || {};
    return album.picUrl || "";
};

// 【新】搜索接口
app.get('/api/search', async (req, res) => {
    try {
        const { keywords } = req.query;
        // 增加 realIP 提高接口稳定性
        const result = await netease.cloudsearch({ 
            keywords, 
            limit: 18, 
            realIP: getIp(req) 
        });

        // 获取原始歌曲列表
        const rawSongs = result.body.result.songs || [];

        // 【核心修改】：通过 map 转换，提取我们需要且整洁的字段
        const cleanedSongs = rawSongs.map(s => ({
            id: s.id,
            name: s.name,
            ar: formatArtists(s), // 使用刚才优化过的歌手解析函数
            pic: getSongPic(s),   // 使用提取封面的函数
            dt: s.dt || s.duration // 兼容不同的时长字段名
        }));

        res.json({ success: true, data: cleanedSongs });
    } catch (e) { 
        console.error('搜索报错:', e);
        res.json({ success: false }); 
    }
});

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
                pic: getSongPic(s),
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

app.get('/api/room/my-rooms', async (req, res) => {
    try {
        const { username } = req.query;
        const user = await User.findOne({ username });
        if (!user) return res.json({ success: false });

        // 1. 查找我创建的
        const owned = await Room.find({ owner: username }).select('roomId name owner').sort({ createdAt: -1 }).lean();
        
        // 2. 查找我收藏的 (排除掉自己创建的，避免重复显示)
        const favoritedIds = user.favorites.filter(id => !owned.some(r => r.roomId === id));
        const favorited = await Room.find({ roomId: { $in: favoritedIds } }).select('roomId name owner').lean();

        res.json({ success: true, owned, favorited });
    } catch (e) { res.json({ success: false }); }
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
            pic: String(song.pic || ''),
            dt: Number(song.dt || 0),
            type: String(song.type || '未知舞种'),
            addedBy: String(username || '匿名舞友'),
            likes: 0,
            likedBy: []
        };
        const room = await Room.findOne({ roomId: roomId });
        if (!room) return res.json({ success: false, message: '找不到该房间' });

        // 检查 songs 数组中是否已经存在该 ID
        const songIdStr = String(song.id || ''); 
        const isDuplicate = room.songs && room.songs.some(s => String(s.id) === songIdStr);
        if (isDuplicate) {
            return res.json({ success: false, message: '这首歌已经在协作清单里啦，不用重复添加' });
        }

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

// 从协作房间移除歌曲
app.post('/api/room/remove-song', async (req, res) => {
    try {
        const { roomId, songId, username } = req.body;
        
        // 1. 获取房间详情
        const room = await Room.findOne({ roomId });
        if (!room) return res.json({ success: false, message: '房间不存在' });

        // 2. 查找歌曲以确认谁添加的
        const song = room.songs.find(s => s.id === String(songId));
        if (!song) return res.json({ success: false, message: '歌曲不在列表中' });

        // 3. 权限校验：只有房主(room.owner) 或 歌曲添加者(song.addedBy) 才能删除
        if (room.owner !== username && song.addedBy !== username) {
            return res.json({ success: false, message: '权限不足：只有房主或添加者能删除' });
        }

        // 4. 执行移除操作 ($pull 是 MongoDB 移除数组元素的专门指令)
        await Room.updateOne(
            { roomId },
            { $pull: { songs: { id: String(songId) } } }
        );

        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: '服务器错误' });
    }
});

// 收藏或取消收藏房间
app.post('/api/room/favorite', async (req, res) => {
    try {
        const { roomId, username } = req.body;
        if (!username) return res.json({ success: false, message: '请先登录' });

        const user = await User.findOne({ username });
        const isFavorited = user.favorites.includes(roomId);

        if (isFavorited) {
            // 如果已收藏，则移除 ($pull)
            await User.updateOne({ username }, { $pull: { favorites: roomId } });
            res.json({ success: true, action: 'removed' });
        } else {
            // 如果未收藏，则添加 ($addToSet 确保不重复)
            await User.updateOne({ username }, { $addToSet: { favorites: roomId } });
            res.json({ success: true, action: 'added' });
        }
    } catch (e) {
        res.json({ success: false });
    }
});

// 获取歌曲播放链接
app.get('/api/song/url', async (req, res) => {
    try {
        const { id, cookie } = req.query;
        // 获取音乐 URL，默认选择标准音质
        const result = await netease.song_url({ 
            id, 
            cookie: cookie || "", 
            realIP: getIp(req) 
        });
        
        const songData = result.body.data[0];
        if (songData && songData.url) {
            res.json({ success: true, url: songData.url });
        } else {
            res.json({ success: false, message: '无法获取播放链接（可能是VIP歌曲或版权限制）' });
        }
    } catch (e) {
        res.json({ success: false, message: '获取失败' });
    }
});

// 获取当前登录用户的歌单列表
app.get('/api/user/playlists', async (req, res) => {
    try {
        const { cookie } = req.query;
        if (!cookie) return res.json({ success: false, message: '未登录' });

        // 1. 获取当前用户 UID
        const statusRes = await netease.login_status({ cookie });
        const myUid = statusRes.body.data.profile.userId;

        // 2. 获取歌单列表 (包含创建和收藏)
        const result = await netease.user_playlist({ uid: myUid, cookie, realIP: getIp(req) });
        
        const playlists = result.body.playlist.map(p => ({
            id: p.id,
            name: p.name,
            cover: p.coverImgUrl,
            trackCount: p.trackCount,
            // 重点：判断是否为我创建的 (userId 一致即为创建，否则为收藏)
            isMine: p.userId === myUid 
        }));

        res.json({ success: true, playlists });
    } catch (e) {
        res.json({ success: false, message: '获取歌单失败' });
    }
});

// 核心生成接口
app.post('/api/calculate', async (req, res) => {
    try {
        let { duration, cookie, requestedSongs = [], useDefaultFill = true, mode = 'sequential', weights = {} , roomId } = req.body;
        if(!cookie) return res.json({ success: false, message: '未检测到网易云登录状态' });
        
        // 1. 合并协作房间点歌与本地点歌 (优先协作)
        let finalRequests = [];
        if (roomId) {
            const room = await Room.findOne({ roomId }).lean();
            if (room && room.songs) {
                const sortedRoomSongs = [...room.songs].sort((a, b) => (b.likes || 0) - (a.likes || 0));
                finalRequests = [...sortedRoomSongs];
            }
        }
        finalRequests = [...finalRequests, ...requestedSongs];
        
        // 2. 准备集体舞
        let collectivePool = [];
        if (useDefaultFill) {
            const colRes = await netease.song_detail({ ids: COLLECTIVE_CONFIG.map(c => c.id).join(','), cookie, realIP: getIp(req) });
            collectivePool = (colRes.body.songs || []).map(s => {
                const cfg = COLLECTIVE_CONFIG.find(c => c.id == s.id);
                return { id: s.id, name: s.name, ar: formatArtists(s), pic: getSongPic(s), dt: s.dt || s.duration, type: cfg.type };
            });
        }

        // 3. 整理点歌池 (修正：动态创建 Key，支持自定义舞种)
        let requestPool = {};
        finalRequests.forEach(s => { 
            if (!requestPool[s.type]) requestPool[s.type] = [];
            requestPool[s.type].push(s); 
        });

        // 4. 准备底库
        let baseData = [[],[],[],[],[],[],[]];
        if (useDefaultFill) {
            const responses = await Promise.all(DEFAULT_PLAYLISTS.map(p => 
                netease.playlist_track_all({ id: p.id, cookie, realIP: getIp(req) })
            ));
            baseData = responses.map(r => (r.body && r.body.songs) ? shuffle([...r.body.songs]) : []);
        }

        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        let basePointers = {}; 
        DEFAULT_PLAYLISTS.forEach(p => basePointers[p.name] = 0);
        
        let roundCounter = 0; 
        let lastType = null;
        let safetyIdx = 0;
      
        // --- 内部辅助函数 ---
        function findSong(typeName) {
            // 先找点歌池
            if (requestPool[typeName]?.length > 0) return requestPool[typeName].shift();
            // 没点歌则找底库 (底库只有7种默认舞)
            if (useDefaultFill) {
                const bIdx = DEFAULT_PLAYLISTS.findIndex(p => p.name === typeName);
                if (bIdx !== -1 && baseData[bIdx] && baseData[bIdx][basePointers[typeName]]) {
                    const raw = baseData[bIdx][basePointers[typeName]++];
                    return { 
                        id: raw.id, name: raw.name, ar: formatArtists(raw), 
                        pic: getSongPic(raw),
                        dt: raw.dt || raw.duration, type: typeName 
                    };
                }
            }
            return null;
        }

        function addSong(song) {
            if (song && !usedIds.has(song.id)) {
                result.push(song);
                usedIds.add(song.id);
                currentMs += song.dt;
                if (!song.type.includes('集体')) roundCounter++;
                return true;
            }
            return false;
        }

        while (currentMs < targetMs && safetyIdx < 600) {
            safetyIdx++;
            let songAddedThisRound = false;

            // 【核心修正 A】：优先处理所有不在 7 大类中的自定义舞种点歌
            for (let type in requestPool) {
                const isDefaultType = DEFAULT_PLAYLISTS.some(p => p.name === type);
                if (!isDefaultType && requestPool[type].length > 0) {
                    if (addSong(requestPool[type].shift())) songAddedThisRound = true;
                }
            }

            // 【核心修正 B】：执行正常的舞种循环
            if (mode === 'weighted') {
                const typeName = pickTypeByWeight(weights, lastType); 
                if (typeName) {
                    let song = findSong(typeName);
                    if (song) { if(addSong(song)) { lastType = typeName; songAddedThisRound = true; } }
                    else { weights[typeName] = 0; } // 该舞种彻底枯竭
                }
            } else {
                for (let i = 0; i < 7; i++) {
                    const typeName = DEFAULT_PLAYLISTS[i].name;
                    const prob = weights[typeName] ?? 1.0;
                    if (Math.random() < prob) {
                        let song = findSong(typeName);
                        if (song) { if(addSong(song)) songAddedThisRound = true; }
                    }
                }
            }

            // 集体舞插入
            if (useDefaultFill && roundCounter >= 7 && collectivePool.length > 0) {
                if (addSong(collectivePool.shift())) {
                    roundCounter = 0;
                    songAddedThisRound = true;
                }
            }

            // 终止条件判断：如果这一整轮没有任何一首歌能加进去，说明所有池子都干了
            if (!songAddedThisRound) {
                const hasAnyRequest = Object.values(requestPool).some(arr => arr.length > 0);
                const hasAnyBase = useDefaultFill && DEFAULT_PLAYLISTS.some(p => baseData[DEFAULT_PLAYLISTS.indexOf(p)][basePointers[p.name]]);
                if (!hasAnyRequest && !hasAnyBase) break;
            }
        }

        res.json({ success: true, songs: result });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.post('/api/sync', async (req, res) => {
    try {
        const { songs, cookie, roomName } = req.body; 
        if (!songs || !cookie) throw new Error('同步失败：缺少必要信息');

        // 正序取 ID，然后 reverse，保持你原来的逻辑
        const trackIds = songs.map(s => s.id).reverse().join(',');
        
        const now = new Date();
        const dateStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
        let playlistName = (roomName && roomName !== '未命名共享歌单') 
                           ? roomName 
                           : `舞会_${dateStr}`;
        
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
