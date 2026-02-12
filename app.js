const express = require('express');
const axios = require('axios');
const netease = require('NeteaseCloudMusicApi');

const app = express();
app.use(express.json());
app.use(express.static('public'));

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

app.post('/api/generate', async (req, res) => {
    try {
        let { duration, cookie, requestedSongs = [] } = req.body;
        
        // 1. 整理用户标记的歌曲池 (按舞种分类)
        let requestPool = {};
        DEFAULT_PLAYLISTS.forEach(p => requestPool[p.name] = []);
        requestedSongs.forEach(s => {
            if (requestPool[s.type]) requestPool[s.type].push(s);
        });

        // 2. 获取底库数据作为补充 (如果用户标记的歌不够长，用底库填补)
        const baseIds = DEFAULT_PLAYLISTS.map(p => p.id);
        const responses = await Promise.all(baseIds.map(id => netease.playlist_track_all({ id, cookie })));
        const baseData = responses.map(r => shuffle([...(r.body.songs || [])]));

        // 3. 混合编排逻辑
        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        let basePointers = new Array(baseData.length).fill(0);
        let hasMore = true;

        while (currentMs < targetMs && hasMore) {
            hasMore = false;
            for (let i = 0; i < 7; i++) {
                const typeName = DEFAULT_PLAYLISTS[i].name;
                let song = null;

                // 优先从用户手动标记的池子里取歌
                if (requestPool[typeName] && requestPool[typeName].length > 0) {
                    song = requestPool[typeName].shift();
                    hasMore = true;
                } 
                // 如果标记的歌用完了，从默认底库抽歌填补空缺
                else if (baseData[i] && basePointers[i] < baseData[i].length) {
                    const rawSong = baseData[i][basePointers[i]++];
                    song = {
                        id: rawSong.id,
                        name: rawSong.name,
                        ar: formatArtists(rawSong),
                        dt: rawSong.dt || rawSong.duration,
                        type: typeName
                    };
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

        // 4. 创建并同步
        const trackIds = result.map(s => s.id).reverse().join(',');
        const createRes = await netease.playlist_create({ name: `舞会_${new Date().toLocaleDateString()}`, cookie });
        const newId = createRes.body.id;
        await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        
        res.json({ success: true, count: result.length, playlistId: newId, songs: result });
    } catch (error) {
        res.json({ success: false, message: '生成失败' });
    }
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
