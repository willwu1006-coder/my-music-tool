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

app.post('/api/generate', async (req, res) => {
    try {
        let { playlistIds, duration, cookie } = req.body;
        let playlistConfigs = [];

        // 确定歌单配置（名称+ID）
        if (!playlistIds || playlistIds.length === 0) {
            playlistConfigs = DEFAULT_PLAYLISTS;
        } else {
            // 如果是用户输入的，并发解析它们
            const ids = await Promise.all(playlistIds.map(l => getRealId(l)));
            if (ids.includes(null)) return res.json({ success: false, message: '部分歌单解析失败' });
            playlistConfigs = ids.map((id, index) => ({ name: `舞种${index + 1}`, id }));
        }

        // 并发获取所有歌曲
        const responses = await Promise.all(playlistConfigs.map(p => netease.playlist_track_all({ id: p.id, cookie })));
        const allData = responses.map(r => r.body.songs);

        // 严格轮询合并
        const targetMs = duration * 60 * 1000;
        let result = [], currentMs = 0, usedIds = new Set();
        // 内部洗牌
        const randomized = allData.map(list => {
            const arr = [...list];
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
            return arr;
        });

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
                            dt: song.dt,
                            type: playlistConfigs[i].name // 记录舞种
                        });
                        usedIds.add(song.id);
                        currentMs += (song.dt || 0);
                    }
                    if (currentMs >= targetMs) break;
                }
            }
        }

        const trackIds = result.map(s => s.id).reverse().join(',');
        const createRes = await netease.playlist_create({
            name: `DanceTool_${new Date().toLocaleDateString()}`,
            cookie
        });
        const newId = createRes.body.id;
        await netease.playlist_tracks({ op: 'add', pid: newId, tracks: trackIds, cookie });
        
        res.json({ success: true, count: result.length, playlistId: newId, songs: result });
    } catch (error) {
        res.json({ success: false, message: '生成出错' });
    }
});

// 登录接口... (保持之前的逻辑)
app.get('/api/login/key', async (req, res) => res.json((await netease.login_qr_key({})).body));
app.get('/api/login/create', async (req, res) => res.json((await netease.login_qr_create({ key: req.query.key, qrimg: true })).body));
app.get('/api/login/check', async (req, res) => res.json((await netease.login_qr_check({ key: req.query.key })).body));

app.listen(process.env.PORT || 8080);
