const express = require('express');
const path = require('path');
// 直接引入网易云 API 的核心功能模块
const netease = require('NeteaseCloudMusicApi');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 核心逻辑：洗牌算法
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 核心逻辑：合并歌单
function mergePlaylists(playlists, targetMin) {
    const targetMs = targetMin * 60 * 1000;
    let result = [];
    let currentMs = 0;
    let usedSongIds = new Set();
    const shuffledPlaylists = playlists.map(list => shuffle([...list]));
    let songPointer = 0;
    let hasMore = true;
    while (currentMs < targetMs && hasMore) {
        hasMore = false;
        for (let i = 0; i < shuffledPlaylists.length; i++) {
            const list = shuffledPlaylists[i];
            if (songPointer < list.length) {
                const song = list[songPointer];
                hasMore = true;
                if (!usedSongIds.has(song.id)) {
                    result.push(song);
                    usedSongIds.add(song.id);
                    currentMs += (song.dt || 0);
                }
                if (currentMs >= targetMs) break;
            }
        }
        songPointer++;
    }
    return result;
}

// 核心逻辑：解析 ID
async function getRealId(input) {
    input = input.trim();
    if (/^\d+$/.test(input)) return input;
    const match = input.match(/id=(\d+)/);
    return match ? match[1] : null;
}
// 1. 获取二维码的 Key
app.get('/api/login/key', async (req, res) => {
    const result = await netease.login_qr_key({});
    res.json(result.body);
});

// 2. 根据 Key 生成二维码图片
app.get('/api/login/create', async (req, res) => {
    const result = await netease.login_qr_create({
        key: req.query.key,
        qrimg: true // 开启 base64 模式，直接返回图片
    });
    res.json(result.body);
});

// 3. 检查扫码状态
app.get('/api/login/check', async (req, res) => {
    const result = await netease.login_qr_check({
        key: req.query.key
    });
    res.json(result.body);
});
// 路由接口
app.post('/api/generate', async (req, res) => {
    try {
        const { playlistIds, duration, cookie } = req.body;
        let allPlaylistsData = [];

        for (let input of playlistIds) {
            const realId = await getRealId(input);
            if (realId) {
                // --- 直接调用 API 函数，不再使用 axios 请求 localhost ---
                const result = await netease.playlist_track_all({
                    id: realId,
                    cookie: cookie
                });
                if (result.body.songs) {
                    allPlaylistsData.push(result.body.songs);
                }
            }
        }

        const finalSongs = mergePlaylists(allPlaylistsData, duration);
        const trackIds = finalSongs.map(s => s.id).join(',');

        // 1. 创建新歌单
        const createRes = await netease.playlist_create({
            name: `随机排歌_${new Date().toLocaleDateString()}`,
            cookie: cookie
        });
        const newId = createRes.body.id;

        // 2. 添加歌曲到新歌单
        await netease.playlist_tracks({
            op: 'add',
            pid: newId,
            tracks: trackIds,
            cookie: cookie
        });

        res.json({ success: true, count: finalSongs.length, playlistId: newId });
    } catch (error) {
        console.error('API Error:', error);
        res.json({ success: false, message: '生成失败，请检查歌单ID或Cookie' });
    }
});

// 监听 Zeabur 提供的端口
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`服务已成功启动！正在监听端口 ${PORT}`);
});
