const express = require('express');
const axios = require('axios');
const netease = require('NeteaseCloudMusicApi');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DEFAULT_PLAYLISTS = [
    {name: "慢三中三", url: "https://163cn.tv/1hf8FgU"},
    {name: "平四", url: "https://163cn.tv/1hfRG6R"},
    {name: "伦巴", url: "https://163cn.tv/1hgrkuh"},
    {name: "并四", url: "https://163cn.tv/1hglpuZ"},
    {name: "快三", url: "https://163cn.tv/1hhfUQZ"},
    {name: "慢四", url: "https://163cn.tv/1hg1gTv"},
    {name: "吉特巴", url: "https://163cn.tv/1hfPAXy"}
];

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

async function getRealId(input) {
    let str = input.trim();
    if (!str) return null;
    const directMatch = str.match(/id=(\d+)/);
    if (directMatch) return directMatch[1];
    const urlMatch = str.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
        try {
            const res = await axios.get(urlMatch[0], { maxRedirects: 5, timeout: 5000 });
            const finalMatch = (res.request.res.responseUrl || '').match(/id=(\d+)/);
            return finalMatch ? finalMatch[1] : null;
        } catch (e) { return null; }
    }
    return str.match(/\d{5,12}/)?.[0] || null;
}

app.post('/api/generate', async (req, res) => {
    try {
        let { playlistIds, duration, cookie } = req.body;
        // 如果用户没填，则使用默认的7个URL
        const links = (playlistIds && playlistIds.length > 0) ? playlistIds : DEFAULT_PLAYLISTS.map(d => d.url);

        // 1. 并发解析 ID
        const realIds = await Promise.all(links.map(l => getRealId(l)));
        
        // 检查是否有歌单解析失败
        if (realIds.includes(null)) {
            const failIndex = realIds.indexOf(null);
            return res.json({ success: false, message: `第 ${failIndex + 1} 个歌单解析失败，请检查链接` });
        }

        // 2. 并发获取歌曲
        const responses = await Promise.all(realIds.map(id => netease.playlist_track_all({ id, cookie })));
        const allData = responses.map(r => r.body.songs);

        // 3. 严格轮询逻辑
        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        const randomized = allData.map(list => shuffle([...list]));
        let pointers = new Array(randomized.length).fill(0), hasMore = true;

        while (currentMs < targetMs && hasMore) {
            hasMore = false;
            for (let i = 0; i < randomized.length; i++) {
                if (pointers[i] < randomized[i].length) {
                    hasMore = true;
                    const song = randomized[i][pointers[i]++];
                    if (!usedIds.has(song.id)) {
                        result.push({
                            id: song.id,
                            name: song.name,
                            ar: song.ar.map(a => a.name).join('/'),
                            dt: song.dt
                        });
                        usedIds.add(song.id);
                        currentMs += (song.dt || 0);
                    }
                    if (currentMs >= targetMs) break;
                }
            }
        }

        // 4. 解决倒序：反转 ID 数组
        const trackIds = result.map(s => s.id).reverse().join(',');

        const createRes = await netease.playlist_create({
            name: `DanceTool_${new Date().toLocaleDateString()}`,
            cookie
        });
        const newId = createRes.body.id;

        await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        
        // 返回成功信息和歌曲清单
        res.json({ 
            success: true, 
            count: result.length, 
            playlistId: newId,
            songs: result // 传回前端展示
        });
    } catch (error) {
        res.json({ success: false, message: '系统错误，请检查登录状态' });
    }
});

// 登录接口
app.get('/api/login/key', async (req, res) => res.json((await netease.login_qr_key({})).body));
app.get('/api/login/create', async (req, res) => res.json((await netease.login_qr_create({ key: req.query.key, qrimg: true })).body));
app.get('/api/login/check', async (req, res) => res.json((await netease.login_qr_check({ key: req.query.key })).body));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
