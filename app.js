const express = require('express');
const axios = require('axios');
const netease = require('NeteaseCloudMusicApi');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 默认歌单顺序：慢三、平四、伦巴、并四、快三、慢四、吉特巴
const DEFAULT_PLAYLISTS = [
    "https://163cn.tv/1hf8FgU", // 慢三
    "https://163cn.tv/1hfRG6R", // 平四
    "https://163cn.tv/1hgrkuh", // 伦巴
    "https://163cn.tv/1hglpuZ", // 并四
    "https://163cn.tv/1hhfUQZ", // 快三
    "https://163cn.tv/1hg1gTv", // 慢四
    "https://163cn.tv/1hfPAXy"  // 吉特巴
];

// 洗牌算法：用于歌单内部随机
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 增强版 ID 解析
async function getRealId(input) {
    let str = input.trim();
    if (!str) return null;
    const urlMatch = str.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        const url = urlMatch[0];
        const idMatch = url.match(/id=(\d+)/);
        if (idMatch) return idMatch[1];
        try {
            const res = await axios.get(url, { maxRedirects: 5, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const finalUrl = res.request.res.responseUrl || '';
            const finalMatch = finalUrl.match(/id=(\d+)/);
            return finalMatch ? finalMatch[1] : null;
        } catch (e) { return null; }
    }
    const pureIdMatch = str.match(/\d{5,12}/);
    return pureIdMatch ? pureIdMatch[0] : null;
}

// 核心逻辑：分类内随机 + 分类间严格轮询
function mergePlaylistsAdvanced(playlists, targetMin) {
    const targetMs = targetMin * 60 * 1000;
    let result = [];
    let currentMs = 0;
    let usedSongIds = new Set();
    
    // 1. 【关键】先对每一个歌单内部进行随机洗牌
    const randomizedPlaylists = playlists.map(list => shuffle([...list]));
    
    let pointers = new Array(randomizedPlaylists.length).fill(0);
    let hasMore = true;

    while (currentMs < targetMs && hasMore) {
        hasMore = false;
        // 2. 严格按照 1-7 的顺序循环抽取
        for (let i = 0; i < randomizedPlaylists.length; i++) {
            const list = randomizedPlaylists[i];
            if (pointers[i] < list.length) {
                hasMore = true;
                const song = list[pointers[i]];
                pointers[i]++;
                
                if (!usedSongIds.has(song.id)) {
                    result.push(song);
                    usedSongIds.add(song.id);
                    currentMs += (song.dt || 0);
                }
                if (currentMs >= targetMs) break;
            }
        }
    }
    return result;
}

app.post('/api/generate', async (req, res) => {
    try {
        let { playlistIds, duration, cookie } = req.body;
        const targetLinks = (playlistIds && playlistIds.length > 0) ? playlistIds : DEFAULT_PLAYLISTS;
        
        let allPlaylistsData = [];
        for (let input of targetLinks) {
            const realId = await getRealId(input);
            if (realId) {
                const result = await netease.playlist_track_all({ id: realId, cookie: cookie });
                if (result.body.songs) allPlaylistsData.push(result.body.songs);
            }
        }

        if (allPlaylistsData.length === 0) return res.json({ success: false, message: '无法解析歌单' });

        const finalSongs = mergePlaylistsAdvanced(allPlaylistsData, duration);
        const trackIds = finalSongs.map(s => s.id).join(',');

        // 创建新歌单
        const createRes = await netease.playlist_create({
            name: `舞厅混排_${new Date().toLocaleDateString()}`,
            cookie: cookie
        });
        const newId = createRes.body.id;

        // 批量添加歌曲（API 会按数组顺序排列，第一个 ID 在最上方）
        await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie: cookie });
        
        res.json({ success: true, count: finalSongs.length, playlistId: newId });
    } catch (error) {
        res.json({ success: false, message: '生成失败，请确认是否登录' });
    }
});

// 登录接口
app.get('/api/login/key', async (req, res) => res.json((await netease.login_qr_key({})).body));
app.get('/api/login/create', async (req, res) => res.json((await netease.login_qr_create({ key: req.query.key, qrimg: true })).body));
app.get('/api/login/check', async (req, res) => res.json((await netease.login_qr_check({ key: req.query.key })).body));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
