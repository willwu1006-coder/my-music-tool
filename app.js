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

app.post('/api/generate', async (req, res) => {
    try {
        let { playlistIds, duration, cookie, requestedSongs = [] } = req.body;
        
        // 1. 获取底库 ID
        let baseIds = [];
        if (!playlistIds || playlistIds.length === 0) {
            baseIds = DEFAULT_PLAYLISTS.map(p => p.id);
        } else {
            baseIds = await Promise.all(playlistIds.map(l => getRealId(l)));
        }

        // 2. 获取底库数据并洗牌
        const responses = await Promise.all(baseIds.map(id => id ? netease.playlist_track_all({ id, cookie }) : {body:{songs:[]}}));
        const baseData = responses.map(r => shuffle([...(r.body.songs || [])]));

        // 3. 整理点歌池
        let requestPool = {};
        DEFAULT_PLAYLISTS.forEach(p => requestPool[p.name] = []);
        requestedSongs.forEach(s => {
            if (requestPool[s.type]) requestPool[s.type].push(s);
        });

        // 4. 混合编排
        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        let basePointers = new Array(baseData.length).fill(0);
        let hasMore = true;

        while (currentMs < targetMs && hasMore) {
            hasMore = false;
            // 严格按 0-6 索引循环，对应 7 种舞
            for (let i = 0; i < 7; i++) {
                // 重点修复：无论底库多长，舞种名称始终取 DEFAULT_PLAYLISTS 的对应项
                const typeName = DEFAULT_PLAYLISTS[i].name;
                let song = null;

                if (requestPool[typeName] && requestPool[typeName].length > 0) {
                    song = requestPool[typeName].shift();
                    hasMore = true;
                } else if (baseData[i] && basePointers[i] < baseData[i].length) {
                    song = baseData[i][basePointers[i]++];
                    hasMore = true;
                }

                if (song && !usedIds.has(song.id)) {
                    // 重点修复：处理 dt 或 duration 字段
                    const songDuration = song.dt || song.duration || 0; 
                    result.push({
                        id: song.id,
                        name: song.name,
                        ar: song.ar ? (Array.isArray(song.ar) ? song.ar.map(a => a.name).join('/') : song.ar) : (song.artists ? song.artists.map(a=>a.name).join('/') : "未知歌手"),
                        dt: songDuration,
                        type: typeName
                    });
                    usedIds.add(song.id);
                    currentMs += songDuration;
                }
                if (currentMs >= targetMs) break;
            }
        }

        const trackIds = result.map(s => s.id).reverse().join(',');
        const createRes = await netease.playlist_create({ name: `DanceV2_${new Date().toLocaleDateString()}`, cookie });
        const newId = createRes.body.id;
        netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        
        res.json({ success: true, count: result.length, playlistId: newId, songs: result });
    } catch (error) {
        console.error(error);
        res.json({ success: false, message: '生成失败，请重试' });
    }
});

app.get('/api/login/key', async (req, res) => res.json((await netease.login_qr_key({})).body));
app.get('/api/login/create', async (req, res) => res.json((await netease.login_qr_create({ key: req.query.key, qrimg: true })).body));
app.get('/api/login/check', async (req, res) => res.json((await netease.login_qr_check({ key: req.query.key })).body));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`V2 PRO Fixed Running`));
