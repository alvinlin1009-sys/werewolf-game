const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const ROLES = {
    WEREWOLF: 'WEREWOLF', VILLAGER: 'VILLAGER', SEER: 'SEER', WITCH: 'WITCH', HUNTER: 'HUNTER'
};
const STATUS = {
    WAITING: 'WAITING', NIGHT_WOLF: 'NIGHT_WOLF', NIGHT_SEER: 'NIGHT_SEER',
    NIGHT_WITCH: 'NIGHT_WITCH', DAY_ANNOUNCE: 'DAY_ANNOUNCE', DAY_LAST_WORDS: 'DAY_LAST_WORDS', DAY_SPEECH: 'DAY_SPEECH',
    DAY_VOTE: 'DAY_VOTE', GAMEOVER: 'GAMEOVER'
};

const rooms = {};

const createRoomState = (roomId) => ({
    roomId,
    status: STATUS.WAITING,
    dayCount: 0,
    players: [],
    currentSpeaker: null,
    lastWordsQueue: [],
    witchHasSave: true,
    witchHasPoison: true,
    phaseEndTime: null,
    wolfVotes: {},
    forcedRoles: {},
    nightKilled: null,
    nightPoisoned: null,
    skipSpeech: null,
    hunterShootTimeout: null,
    votes: {}
});

const BOT_SPEECHES = [
    "我是好人，過。", "我現在還沒有什麼頭緒，聽聽後面怎麼說。", "昨天晚上挺安靜的，大家有什麼發現嗎？",
    "目前資訊太少，先不盲目投票。", "我覺得這局挺有意思的，看看誰發言有漏洞。", "大家要仔細聽發言，不要輕易被帶風向。",
    "我是個平民，沒有任何資訊可以提供。", "我有點懷疑上一位發言的人，但我保留意見。", "好人應該要團結起來，把狼人找出來！",
    "這回合我先棄票，或者隨大流投吧。"
];
const getBotSpeech = () => BOT_SPEECHES[Math.floor(Math.random() * BOT_SPEECHES.length)];

const broadcast = (room, msg) => {
    io.to(room.roomId).emit('game_update', { message: msg, state: room });
};
const sendToPlayer = (id, data) => io.to(id).emit('private_msg', data);

const checkWinCondition = (room) => {
    const alive = room.players.filter(p => p.isAlive);
    const wolves = alive.filter(p => p.role === ROLES.WEREWOLF).length;
    const gods = alive.filter(p => [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER].includes(p.role)).length;
    const villagers = alive.filter(p => p.role === ROLES.VILLAGER).length;
    if (wolves === 0) return "GOOD_WIN";
    if (gods === 0 || villagers === 0) return "WOLF_WIN";
    return null;
};

const transitionTo = (room, newStatus, message) => {
    console.log(`[Room ${room.roomId}] Transitioning to ${newStatus}: ${message}`);
    room.status = newStatus;
    broadcast(room, message);
};

const assignRoles = (room) => {
    const baseRoles = [
        ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WEREWOLF,
        ROLES.SEER, ROLES.WITCH, ROLES.HUNTER,
        ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER
    ];
    room.players.forEach(p => {
        if (room.forcedRoles[p.id]) {
            const roleIndex = baseRoles.indexOf(room.forcedRoles[p.id]);
            if (roleIndex !== -1) {
                p.role = baseRoles.splice(roleIndex, 1)[0];
            }
        }
    });
    const remainingRoles = [...baseRoles].sort(() => Math.random() - 0.5);
    room.players.forEach(p => {
        if (!p.role) p.role = remainingRoles.pop();
        sendToPlayer(p.id, { type: 'ROLE_ASSIGN', role: p.role });
    });
};

const initGame = (room) => {
    room.status = STATUS.NIGHT_WOLF;
    assignRoles(room);
    room.forcedRoles = {};
    broadcast(room, "遊戲開始！身分已分配完畢。");
    setTimeout(() => startNightCycle(room), 3000);
};

const startNightCycle = (room) => {
    room.nightKilled = null;
    room.nightPoisoned = null;
    room.wolfVotes = {};
    transitionTo(room, STATUS.NIGHT_WOLF, "天黑請閉眼。狼人請睜眼！");

    const botWolves = room.players.filter(p => p.role === ROLES.WEREWOLF && p.isAlive && p.isBot);
    botWolves.forEach(bot => {
        setTimeout(() => {
            if (room.status !== STATUS.NIGHT_WOLF) return;
            const alive = room.players.filter(p => p.isAlive && p.role !== ROLES.WEREWOLF);
            if (alive.length > 0) {
                const targetSeat = alive[Math.floor(Math.random() * alive.length)].seat;
                room.wolfVotes[bot.seat] = targetSeat;
                const wolfIds = room.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
                wolfIds.forEach(id => {
                    if (id.startsWith('BOT_')) return;
                    io.to(id).emit('game_update', { message: `[WOLF] 機器人 ${bot.seat} 號投票擊殺 ${targetSeat} 號玩家`, state: room });
                });
            }
        }, 1000);
    });

    const hasHumanWolf = room.players.some(p => p.role === ROLES.WEREWOLF && p.isAlive && !p.isBot);
    const phaseDuration = hasHumanWolf ? 30000 : 3000;
    room.phaseEndTime = Date.now() + phaseDuration;
    broadcast(room, "天黑請閉眼。狼人請睜眼！");

    setTimeout(() => {
        if (room.status !== STATUS.NIGHT_WOLF) return;
        const voteCounts = {};
        Object.values(room.wolfVotes).forEach(target => { voteCounts[target] = (voteCounts[target] || 0) + 1; });
        let maxVotes = 0, maxTargets = [];
        for (const [target, count] of Object.entries(voteCounts)) {
            if (count > maxVotes) { maxVotes = count; maxTargets = [parseInt(target)]; }
            else if (count === maxVotes) { maxTargets.push(parseInt(target)); }
        }
        if (maxTargets.length > 0) {
            room.nightKilled = maxTargets[Math.floor(Math.random() * maxTargets.length)];
        } else {
            const alive = room.players.filter(p => p.isAlive);
            if (alive.length > 0) room.nightKilled = alive[Math.floor(Math.random() * alive.length)].seat;
        }
        startSeerPhase(room);
    }, phaseDuration);
};

const startSeerPhase = (room) => {
    transitionTo(room, STATUS.NIGHT_SEER, "預言家請睜眼，請選擇要查驗的玩家。");
    const hasHumanSeer = room.players.some(p => p.role === ROLES.SEER && p.isAlive && !p.isBot);
    const phaseDuration = hasHumanSeer ? 15000 : 3000;
    room.phaseEndTime = Date.now() + phaseDuration;
    broadcast(room, "預言家請睜眼，請選擇要查驗的玩家。"); // 重新發送以更新 phaseEndTime

    setTimeout(() => {
        if (room.status !== STATUS.NIGHT_SEER) return;
        startWitchPhase(room);
    }, phaseDuration);
};

const promptWitchPoison = (room, witch) => {
    if (room.witchHasPoison) {
        sendToPlayer(witch.id, { type: 'WITCH_PROMPT', msg: "毒殺玩家請輸入: poison [號碼]\n不使用請輸入: poison 0" });
    }
};

const startWitchPhase = (room) => {
    transitionTo(room, STATUS.NIGHT_WITCH, "女巫請睜眼。");
    room.witchUsedPotionThisNight = false;
    const witch = room.players.find(p => p.role === ROLES.WITCH && p.isAlive);
    if (witch) {
        if (witch.isBot) {
            setTimeout(() => {
                if (room.status !== STATUS.NIGHT_WITCH) return;
                if (room.witchHasSave && room.nightKilled !== null) {
                    if (Math.random() > 0.5) { room.nightKilled = null; room.witchHasSave = false; }
                } else if (room.witchHasPoison) {
                    if (Math.random() > 0.7) {
                        const alive = room.players.filter(p => p.isAlive && p.seat !== witch.seat);
                        if (alive.length > 0) {
                            room.nightPoisoned = alive[Math.floor(Math.random() * alive.length)].seat;
                            room.witchHasPoison = false;
                        }
                    }
                }
            }, 1000);
        } else {
            if (room.witchHasSave) {
                sendToPlayer(witch.id, { type: 'WITCH_PROMPT', msg: `今晚被殺的是 ${room.nightKilled} 號玩家。\n使用解藥請輸入: save 1\n不使用請輸入: save 0` });
            } else {
                promptWitchPoison(room, witch);
            }
        }
    }
    const hasHumanWitch = witch && !witch.isBot;
    const phaseDuration = hasHumanWitch ? 20000 : 3000;
    room.phaseEndTime = Date.now() + phaseDuration;
    broadcast(room, "女巫請睜眼。");

    setTimeout(() => {
        if (room.status !== STATUS.NIGHT_WITCH) return;
        startDayPhase(room);
    }, phaseDuration);
};

const startDayPhase = (room) => {
    room.dayCount++;
    transitionTo(room, STATUS.DAY_ANNOUNCE, `第 ${room.dayCount} 天天亮了...`);
    let deadThisNight = [];
    let hunterToShoot = null;
    let deadPlayers = [];

    if (room.nightKilled) {
        const p = room.players.find(p => p.seat === room.nightKilled);
        if (p) { 
            p.isAlive = false; 
            deadThisNight.push(p.name);
            deadPlayers.push(p);
            if (p.role === ROLES.HUNTER) hunterToShoot = p;
        }
    }
    if (room.nightPoisoned) {
        const p = room.players.find(p => p.seat === room.nightPoisoned);
        if (p && p.isAlive) { 
            p.isAlive = false; 
            deadThisNight.push(p.name);
            deadPlayers.push(p);
            if (p.role === ROLES.HUNTER && hunterToShoot === p) {
                hunterToShoot = null; // 女巫毒死的獵人不能開槍
            }
        }
    }

    if (room.dayCount === 1) {
        // 第一天晚上的死者都有遺言
        room.lastWordsQueue = deadPlayers.map(p => p.seat);
    }

    broadcast(room, deadThisNight.length > 0 ? `昨晚，${deadThisNight.join(' 和 ')} 慘遭殺害。` : "昨晚是個平安夜，沒有人死亡。");
    
    setTimeout(() => {
        const winner = checkWinCondition(room);
        if (winner) {
            transitionTo(room, STATUS.GAMEOVER, `遊戲結束！獲勝陣營：${winner === 'GOOD_WIN' ? '好人' : '狼人'}`);
            return;
        }

        if (hunterToShoot) {
            promptHunter(room, hunterToShoot, false, () => startLastWordsPhase(room, () => startSpeechPhase(room)));
        } else {
            startLastWordsPhase(room, () => startSpeechPhase(room));
        }
    }, 5000);
};

const startLastWordsPhase = (room, nextPhaseCallback) => {
    if (!room.lastWordsQueue || room.lastWordsQueue.length === 0) {
        return nextPhaseCallback();
    }
    transitionTo(room, STATUS.DAY_LAST_WORDS, "進入遺言階段...");
    
    let speakerIdx = 0;
    const runLastWordsCycle = async () => {
        if (room.status !== STATUS.DAY_LAST_WORDS) return;
        const currentSeat = room.lastWordsQueue[speakerIdx];
        const current = room.players.find(p => p.seat === currentSeat);
        
        if (!current) {
            speakerIdx++;
            if (speakerIdx >= room.lastWordsQueue.length) {
                room.lastWordsQueue = [];
                nextPhaseCallback();
            } else runLastWordsCycle();
            return;
        }

        room.currentSpeaker = current.seat;
        room.phaseEndTime = Date.now() + 45000;
        broadcast(room, `請 ${current.seat} 號玩家 (${current.name}) 發表遺言。(45秒)`);
        
        if (current.isBot) {
            await new Promise(res => setTimeout(res, 2000));
            if (room.status === STATUS.DAY_LAST_WORDS && room.currentSpeaker === current.seat) {
                broadcast(room, `[👻 遺言] ${current.name}: 我是個好人啊，你們一定會後悔的！`);
            }
            await new Promise(res => setTimeout(res, 1000));
        } else {
            sendToPlayer(current.id, { type: 'LAST_WORDS_UNLOCK' });
            await new Promise(res => {
                let skipped = false;
                const timer = setTimeout(() => {
                    if (!skipped) { skipped = true; room.skipSpeech = null; res(); }
                }, 45000);
                room.skipSpeech = () => {
                    if (!skipped) { skipped = true; clearTimeout(timer); room.skipSpeech = null; res(); }
                };
            });
        }
        
        if (room.status === STATUS.DAY_LAST_WORDS) {
            speakerIdx++;
            if (speakerIdx >= room.lastWordsQueue.length) {
                room.lastWordsQueue = [];
                nextPhaseCallback();
            } else runLastWordsCycle();
        }
    };
    runLastWordsCycle();
};

const promptHunter = (room, hunter, isDay, nextPhaseCallback) => {
    broadcast(room, `昨晚死去的竟然是獵人！他有 15 秒的時間可以開槍！`);
    room.phaseEndTime = Date.now() + 15000;
    broadcast(room, `昨晚死去的竟然是獵人！他有 15 秒的時間可以開槍！`);
    if (hunter.isBot) {
        setTimeout(() => {
            const alive = room.players.filter(p => p.isAlive);
            if (alive.length > 0) {
                const target = alive[Math.floor(Math.random() * alive.length)].seat;
                const tp = room.players.find(p => p.seat === target);
                tp.isAlive = false;
                if (isDay) room.lastWordsQueue.push(tp.seat);
                broadcast(room, `砰！獵人開槍帶走了 ${target} 號玩家！`);
            }
            setTimeout(() => {
                const winner = checkWinCondition(room);
                if (winner) transitionTo(room, STATUS.GAMEOVER, `遊戲結束！獲勝陣營：${winner === 'GOOD_WIN' ? '好人' : '狼人'}`);
                else nextPhaseCallback();
            }, 3000);
        }, 2000);
    } else {
        sendToPlayer(hunter.id, { type: 'SHOOT_PROMPT', msg: "你即將死亡！請問你要開槍帶走誰？(請輸入號碼)" });
        room.hunterShootTimeout = setTimeout(() => {
            room.hunterShootTimeout = null;
            broadcast(room, "獵人猶豫不決，沒有開出那一槍。");
            const winner = checkWinCondition(room);
            if (winner) transitionTo(room, STATUS.GAMEOVER, `遊戲結束！獲勝陣營：${winner === 'GOOD_WIN' ? '好人' : '狼人'}`);
            else nextPhaseCallback();
        }, 15000);
    }
};

const startSpeechPhase = (room) => {
    transitionTo(room, STATUS.DAY_SPEECH, "進入白天發言階段。請等待輪到你發言。");
    const alivePlayers = room.players.filter(p => p.isAlive).sort((a,b) => a.seat - b.seat);
    let speakerIdx = 0;
    const runSpeechCycle = async () => {
        if (room.status !== STATUS.DAY_SPEECH) return;
        const current = alivePlayers[speakerIdx];
        if (!current) return;
        room.currentSpeaker = current.seat;
        room.phaseEndTime = Date.now() + 45000;
        broadcast(room, `現在輪到 ${current.seat} 號玩家 (${current.name}) 發言。(45秒)`);
        
        if (current.isBot) {
            await new Promise(res => setTimeout(res, 2000));
            if (room.status === STATUS.DAY_SPEECH && room.currentSpeaker === current.seat) {
                broadcast(room, `[🗣️ 發言] ${current.name}: ${getBotSpeech()}`);
            }
            await new Promise(res => setTimeout(res, 1000));
        } else {
            sendToPlayer(current.id, { type: 'SPEECH_UNLOCK' });
            await new Promise(res => {
                let skipped = false;
                const timer = setTimeout(() => {
                    if (!skipped) { skipped = true; room.skipSpeech = null; res(); }
                }, 45000);
                room.skipSpeech = () => {
                    if (!skipped) { skipped = true; clearTimeout(timer); room.skipSpeech = null; res(); }
                };
            });
        }
        if (room.status === STATUS.DAY_SPEECH) {
            speakerIdx++;
            if (speakerIdx >= alivePlayers.length) startVotingPhase(room);
            else runSpeechCycle();
        }
    };
    runSpeechCycle();
};

const startVotingPhase = (room) => {
    transitionTo(room, STATUS.DAY_VOTE, "進入投票階段！請票出你心中的狼人！");
    room.votes = {};
    room.phaseEndTime = Date.now() + 30000;
    broadcast(room, "進入投票階段！請票出你心中的狼人！");

    room.players.filter(p => p.isAlive && p.isBot).forEach(bot => {
        setTimeout(() => {
            if (room.status !== STATUS.DAY_VOTE) return;
            const alive = room.players.filter(p => p.isAlive && p.seat !== bot.seat);
            if (alive.length > 0) {
                const target = alive[Math.floor(Math.random() * alive.length)].seat;
                room.votes[bot.seat] = target;
                broadcast(room, `${bot.seat} 號玩家投票給了 ${target} 號`);
            }
        }, Math.random() * 5000 + 2000);
    });

    setTimeout(() => {
        if (room.status !== STATUS.DAY_VOTE) return;
        const counts = {};
        Object.values(room.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
        let maxVotes = 0, exiledSeat = null;
        for (let seat in counts) { if (counts[seat] > maxVotes) { maxVotes = counts[seat]; exiledSeat = parseInt(seat); } }
        if (exiledSeat) {
            const victim = room.players.find(p => p.seat === exiledSeat);
            victim.isAlive = false;
            broadcast(room, `${exiledSeat} 號玩家 (${victim.name}) 被大家公投放逐了！`);
            
            room.lastWordsQueue = [victim.seat]; // 被放逐者有遺言
            
            const winner = checkWinCondition(room);
            if (winner) {
                setTimeout(() => transitionTo(room, STATUS.GAMEOVER, `遊戲結束！獲勝陣營：${winner === 'GOOD_WIN' ? '好人' : '狼人'}`), 3000);
                return;
            }

            if (victim.role === ROLES.HUNTER) {
                setTimeout(() => {
                    promptHunter(room, victim, true, () => startLastWordsPhase(room, () => startNightCycle(room)));
                }, 3000);
                return;
            }
        } else { 
            broadcast(room, "大家猶豫不決，沒有人被放逐。"); 
        }
        
        setTimeout(() => {
            const winner = checkWinCondition(room);
            if (winner) transitionTo(room, STATUS.GAMEOVER, `遊戲結束！獲勝陣營：${winner === 'GOOD_WIN' ? '好人' : '狼人'}`);
            else startLastWordsPhase(room, () => startNightCycle(room));
        }, 5000);
    }, 30000);
};

io.on('connection', (socket) => {
    socket.on('create_room', (name) => {
        const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
        rooms[roomId] = createRoomState(roomId);
        socket.join(roomId);
        socket.roomId = roomId;
        const room = rooms[roomId];
        const seat = 1;
        room.players.push({ id: socket.id, seat, name, role: null, isAlive: true, isBot: false });
        broadcast(room, `玩家 ${name} 建立了房間 ${roomId}，並成為 ${seat} 號。`);
    });

    socket.on('join_room', ({ name, roomId }) => {
        if (!roomId) return;
        roomId = roomId.toUpperCase();
        const room = rooms[roomId];
        if (!room) return sendToPlayer(socket.id, { error: "找不到該房間。" });
        if (room.status !== STATUS.WAITING) return sendToPlayer(socket.id, { error: "該房間的遊戲已經開始了。" });
        if (room.players.length >= 9) return sendToPlayer(socket.id, { error: "該房間已滿。" });

        socket.join(roomId);
        socket.roomId = roomId;
        const seat = room.players.length + 1;
        room.players.push({ id: socket.id, seat, name, role: null, isAlive: true, isBot: false });
        broadcast(room, `玩家 ${name} 加入了房間 ${roomId}，座位是 ${seat} 號。`);
        if (room.players.length === 9) {
            broadcast(room, "所有玩家已就緒。遊戲將在 3 秒後開始...");
            setTimeout(() => { if (room.status === STATUS.WAITING) initGame(room); }, 3000);
        }
    });

    socket.on('add_bot', () => {
        const room = rooms[socket.roomId];
        if (!room || room.status !== STATUS.WAITING || room.players.length >= 9) return;
        const seat = room.players.length + 1;
        const name = `機器人 ${seat} 號`;
        room.players.push({ id: `BOT_${seat}_${Date.now()}`, seat, name, role: null, isAlive: true, isBot: true });
        broadcast(room, `玩家 ${name} 加入了房間 ${room.roomId}，座位是 ${seat} 號。`);
        if (room.players.length === 9) {
            broadcast(room, "所有玩家已就緒。遊戲將在 3 秒後開始...");
            setTimeout(() => { if (room.status === STATUS.WAITING) initGame(room); }, 3000);
        }
    });

    socket.on('force_role', (role) => {
        const room = rooms[socket.roomId];
        if (room && room.status === STATUS.WAITING) {
            if (role === 'RANDOM') delete room.forcedRoles[socket.id];
            else room.forcedRoles[socket.id] = role;
            sendToPlayer(socket.id, { msg: `系統提示：你已將自己的身分指定為 ${role === 'RANDOM' ? '隨機' : role}` });
        }
    });

    socket.on('end_speech', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player && (room.status === STATUS.DAY_SPEECH || room.status === STATUS.DAY_LAST_WORDS) && room.currentSpeaker === player.seat) {
            if (room.skipSpeech) room.skipSpeech();
        }
    });

    socket.on('game_action', (data) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isAlive) return;
        const { cmd, target } = data;
        if (cmd === 'kill' && room.status === STATUS.NIGHT_WOLF && player.role === ROLES.WEREWOLF) {
            const targetSeat = parseInt(target);
            const targetPlayer = room.players.find(p => p.seat === targetSeat && p.isAlive);
            if (targetPlayer && targetPlayer.role !== ROLES.WEREWOLF) {
                room.wolfVotes[player.seat] = targetSeat;
                const wolfIds = room.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
                wolfIds.forEach(id => {
                    if (!id.startsWith('BOT_')) io.to(id).emit('game_update', { message: `[WOLF] 玩家 ${player.name} 投票擊殺 ${targetSeat} 號`, state: room });
                });
            } else { sendToPlayer(socket.id, { error: "無效的目標。" }); }
        } else if (cmd === 'check' && room.status === STATUS.NIGHT_SEER && player.role === ROLES.SEER) {
            const targetPlayer = room.players.find(p => p.seat === parseInt(target));
            sendToPlayer(socket.id, { msg: `查驗結果：${target} 號玩家的真實身分是 ${targetPlayer?.role === ROLES.WEREWOLF ? '狼人 🐺' : '好人 🧑'}` });
        } else if (cmd === 'save' && room.status === STATUS.NIGHT_WITCH && player.role === ROLES.WITCH) {
            let usedSave = false;
            if (parseInt(target) === 1 && room.witchHasSave) { 
                room.nightKilled = null; 
                room.witchHasSave = false; 
                room.witchUsedPotionThisNight = true;
                usedSave = true;
                sendToPlayer(socket.id, { msg: "你使用了解藥！今晚無法再使用毒藥。" }); 
            } else if (parseInt(target) === 0) {
                sendToPlayer(socket.id, { msg: "你選擇不使用解藥。" });
            }
            if (!usedSave) {
                promptWitchPoison(room, player);
            }
        } else if (cmd === 'poison' && room.status === STATUS.NIGHT_WITCH && player.role === ROLES.WITCH) {
            if (room.witchUsedPotionThisNight) {
                sendToPlayer(socket.id, { error: "你今晚已經使用過解藥，無法再使用毒藥！" });
                return;
            }
            if (parseInt(target) !== 0 && room.witchHasPoison) { 
                room.nightPoisoned = parseInt(target); 
                room.witchHasPoison = false; 
                room.witchUsedPotionThisNight = true;
                sendToPlayer(socket.id, { msg: `你毒殺了 ${target} 號玩家！` }); 
            } else if (parseInt(target) === 0) {
                sendToPlayer(socket.id, { msg: "你選擇不使用毒藥。" });
            }
        } else if (cmd === 'vote' && room.status === STATUS.DAY_VOTE) {
            room.votes[player.seat] = parseInt(target);
            broadcast(room, `${player.seat} 號玩家投票給了 ${target} 號`);
        } else if (cmd === 'shoot' && player.role === ROLES.HUNTER) {
            if (room.hunterShootTimeout) {
                clearTimeout(room.hunterShootTimeout);
                room.hunterShootTimeout = null;
                const targetPlayer = room.players.find(p => p.seat === parseInt(target));
                if (targetPlayer && targetPlayer.isAlive) {
                    targetPlayer.isAlive = false;
                    const isDayHunter = (room.status === STATUS.DAY_VOTE); // 白天的獵人(被公投)
                    if (isDayHunter) room.lastWordsQueue.push(targetPlayer.seat);
                    broadcast(room, `砰！獵人開槍帶走了 ${target} 號玩家！`);
                } else {
                    broadcast(room, `砰！獵人朝著天空盲目開了一槍，什麼都沒打中！`);
                }
                setTimeout(() => {
                    const winner = checkWinCondition(room);
                    if (winner) transitionTo(room, STATUS.GAMEOVER, `遊戲結束！獲勝陣營：${winner === 'GOOD_WIN' ? '好人' : '狼人'}`);
                    else {
                        if (room.status === STATUS.DAY_ANNOUNCE) startLastWordsPhase(room, () => startSpeechPhase(room));
                        else startLastWordsPhase(room, () => startNightCycle(room));
                    }
                }, 5000);
            } else {
                sendToPlayer(socket.id, { error: "你現在不能開槍！" });
            }
        }
    });

    socket.on('chat_message', (msg) => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return; // Allow dead players to chat if it's their last words
        
        if (room.status === STATUS.NIGHT_WOLF && player.role === ROLES.WEREWOLF && player.isAlive) {
            const wolfIds = room.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
            wolfIds.forEach(id => {
                if (!id.startsWith('BOT_')) io.to(id).emit('game_update', { message: `[WOLF] ${player.name}: ${msg}`, state: room });
            });
        } else if ((room.status === STATUS.DAY_SPEECH || room.status === STATUS.DAY_LAST_WORDS) && room.currentSpeaker === player.seat) {
            const now = Date.now();
            if (player.lastSpeechTime && now - player.lastSpeechTime < 3000) {
                sendToPlayer(socket.id, { msg: "系統提示：請等待 3 秒後再發言！" });
                return;
            }
            player.lastSpeechTime = now;
            const prefix = room.status === STATUS.DAY_LAST_WORDS ? '[👻 遺言]' : '[🗣️ 發言]';
            broadcast(room, `${prefix} ${player.name}: ${msg}`);
        } else {
            sendToPlayer(socket.id, { error: "你現在不能發言！" });
        }
    });

    socket.on('disconnect', () => {
        const room = rooms[socket.roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isAlive = false;
    });
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
