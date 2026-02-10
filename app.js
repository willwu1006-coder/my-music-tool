const express = require('express');
const axios = require('axios');
const path = require('path');
// --- 修改这里：使用正确的引入方式 ---
const { serveNeteaseCloudMusicApi } = require('NeteaseCloudMusicApi/server');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 自动启动网易云API服务
const API_PORT = 3000;
async function startApi() {
    try {
        await serveNeteaseCloudMusicApi({ port: API_PORT });
        console.log(`网易云接口已运行在端口: ${API_PORT}`);
    } catch (err) {
        console.error('API启动失败:', err);
    }
}
startApi();

const API_URL = `http://localhost:${API_PORT}`;

// 核心逻辑函数
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function getRealId(input) {
    input = input.trim();
    if (/^\d+$/.test(input)) return input;
    try {
        const res = await axios.get(input, { maxRedirects: 5 });
        const finalUrl = res.request.res.responseUrl || '';
        const match = finalUrl.match(/id=(\d+)/);
        return match ? match[1] : null;
    } catch (e) { return null; }
}

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
                    currentMs += song.dt;
                }
                if (currentMs >= targetMs) break;
            }
        }
        songPointer++;
    }
    return result;
}

// 接口
app.post('/api/generate', async (req, res) => {
    try {
        const { playlistIds, duration, cookie } = req.body;
        let allPlaylistsData = [];
        for (let input of playlistIds) {
            const realId = await getRealId(input);
            if (realId) {
                const response = await axios.get(`${API_URL}/playlist/track/all?id=${realId}&cookie=${encodeURIComponent(cookie)}`);
                if (response.data.songs) allPlaylistsData.push(response.data.songs);
            }
        }
        const finalSongs = mergePlaylists(allPlaylistsData, duration);
        const trackIds = finalSongs.map(s => s.id).join(',');
        const createRes = await axios.get(`${API_URL}/playlist/create?name=随机排歌_${new Date().toLocaleDateString()}&cookie=${encodeURIComponent(cookie)}`);
        const newId = createRes.data.id;
        await axios.get(`${API_URL}/playlist/tracks?op=add&pid=${newId}&tracks=${trackIds}&cookie=${encodeURIComponent(cookie)}`);
        res.json({ success: true, count: finalSongs.length, playlistId: newId });
    } catch (error) {
        res.json({ success: false, message: '生成失败，请检查Cookie' });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`服务启动在端口 ${PORT}`));
