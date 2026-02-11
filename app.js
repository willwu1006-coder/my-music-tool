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

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 快速解析 ID
async function getRealId(input) {
    let str = input.trim();
    if (!str) return null;
    const directMatch = str.match(/id=(\d+)/);
    if (directMatch) return directMatch[1];
    const urlMatch = str.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        try {
            const res = await axios.get(urlMatch[0], { maxRedirects: 5, timeout: 3000 });
            const finalMatch = (res.request.res.responseUrl || '').match(/id=(\d+)/);
            return finalMatch ? finalMatch[1] : null;
        } catch (e) { return null; }
    }
    return str.match(/\d{5,12}/)?.[0] || null;
}

app.post('/api/generate', async (req, res) => {
    try {
        let { playlistIds, duration, cookie } = req.body;
        const links = (playlistIds && playlistIds.length > 0) ? playlistIds : DEFAULT_PLAYLISTS;

        // --- 性能优化：并发解析所有 ID ---
        const idPromises = links.map(link => getRealId(link));
        const realIds = (await Promise.all(idPromises)).filter(id => id);

        // --- 性能优化：并发获取所有歌单详情 ---
        const dataPromises = realIds.map(id => netease.playlist_track_all({ id, cookie }));
        const responses = await Promise.all(dataPromises);
        const allPlaylistsData = responses.map(r => r.body.songs).filter(s => s);

        if (allPlaylistsData.length === 0) return res.json({ success: false, message: '解析失败' });

        // 逻辑合并
        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        const randomized = allPlaylistsData.map(list => shuffle([...list]));
        let pointers = new Array(randomized.length).fill(0), hasMore = true;

        while (currentMs < targetMs && hasMore) {
            hasMore = false;
            for (let i = 0; i < randomized.length; i++) {
                if (pointers[i] < randomized[i].length) {
                    hasMore = true;
                    const song = randomized[i][pointers[i]++];
                    if (!usedIds.has(song.id)) {
                        result.push(song);
                        usedIds.add(song.id);
                        currentMs += (song.dt || 0);
                    }
                    if (currentMs >= targetMs) break;
                }
            }
        }

        // --- 解决倒序：反转数组，确保第一首在 App 最上方 ---
        const trackIds = result.map(s => s.id).reverse().join(',');

        const createRes = await netease.playlist_create({
            name: `舞厅专业混排_${new Date().toLocaleDateString()}`,
            cookie
        });
        const newId = createRes.body.id;

        await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        res.json({ success: true, count: result.length, playlistId: newId });
    } catch (error) {
        res.json({ success: false, message: '生成出错' });
    }
});

// 登录接口简写
app.get('/api/login/key', async (req, res) => res.json((await netease.login_qr_key({})).body));
app.get('/api/login/create', async (req, res) => res.json((await netease.login_qr_create({ key: req.query.key, qrimg: true })).body));
app.get('/api/login/check', async (req, res) => res.json((await netease.login_qr_check({ key: req.query.key })).body));

// --- 端口占用保护逻辑 ---
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => console.log(`Server on ${PORT}`))
    .on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log('端口占用，正在重试...');
            setTimeout(() => { server.close(); server.listen(PORT); }, 1000);
        }
    });
