 const express = require('express');
  const http = require('http');
  const { Server } = require('socket.io');
  const cors = require('cors');
  const path = require('path');

  const app = express();
  app.use(cors());
  const server = http.createServer(app);
  const io = new Server(server, {
      cors: { origin: "*" }
  });

  // ==========================================
  // 遊戲設定與資料結構
  // ==========================================
  const ROLES = {
      WEREWOLF: 'WEREWOLF',
      VILLAGER: 'VILLAGER',
      SEER: 'SEER',
      WITCH: 'WITCH',
      HUNTER: 'HUNTER'
  };

  const STATUS = {
      WAITING: 'WAITING',
      NIGHT_WOLF: 'NIGHT_WOLF',
      NIGHT_SEER: 'NIGHT_SEER',
      NIGHT_WITCH: 'NIGHT_WITCH',
      DAY_ANNOUNCE: 'DAY_ANNOUNCE',
      DAY_SPEECH: 'DAY_SPEECH',
      DAY_VOTE: 'DAY_VOTE',
      GAMEOVER: 'GAMEOVER'
  };

  let gameState = {
      roomID: "GLOBAL_ROOM",
      status: STATUS.WAITING,
      players: [],
      currentSpeaker: null,
      witchHasSave: true,
      witchHasPoison: true,
      speechEndTime: null,
      wolfVotes: {},
      forcedRoles: {},
      nightKilled: null,
      nightPoisoned: null,
      skipSpeech: null,
      votes: {},
  };

  // ==========================================
  // 工具函數與常數
  // ==========================================
  const BOT_SPEECHES = [
      "我是好人，過。",
      "我現在還沒有什麼頭緒，聽聽後面怎麼說。",
      "昨天晚上挺安靜的，大家有什麼發現嗎？",
      "目前資訊太少，先不盲目投票。",
      "我覺得這局挺有意思的，看看誰發言有漏洞。",
      "大家要仔細聽發言，不要輕易被帶風向。",
      "我是個平民，沒有任何資訊可以提供。",
      "我有點懷疑上一位發言的人，但我保留意見。",
      "好人應該要團結起來，把狼人找出來！",
      "這回合我先棄票，或者隨大流投吧。"
  ];

  const getBotSpeech = () => BOT_SPEECHES[Math.floor(Math.random() * BOT_SPEECHES.length)];

  const broadcast = (msg) => io.emit('game_update', { message: msg, state: gameState });
  const sendToPlayer = (id, data) => io.to(id).emit('private_msg', data);

  const checkWinCondition = () => {
      const alive = gameState.players.filter(p => p.isAlive);
      const wolves = alive.filter(p => p.role === ROLES.WEREWOLF).length;
      const gods = alive.filter(p => [ROLES.SEER, ROLES.WITCH, ROLES.HUNTER].includes(p.role)).length;
      const villagers = alive.filter(p => p.role === ROLES.VILLAGER).length;
      if (wolves === 0) return "GOOD_WIN";
      if (gods === 0 || villagers === 0) return "WOLF_WIN";
      return null;
  };

  // ==========================================
  // 遊戲流程控制 (State Machine)
  // ==========================================
  const transitionTo = (newStatus, message) => {
      console.log(`Transitioning to ${newStatus}: ${message}`);
      gameState.status = newStatus;
      broadcast(message);
  };

  const assignRoles = () => {
      const baseRoles = [
          ROLES.WEREWOLF, ROLES.WEREWOLF, ROLES.WEREWOLF,
          ROLES.SEER, ROLES.WITCH, ROLES.HUNTER,
          ROLES.VILLAGER, ROLES.VILLAGER, ROLES.VILLAGER
      ];

      // 優先分配管理者指定的身份
      gameState.players.forEach(p => {
          if (gameState.forcedRoles[p.id]) {
              const roleIndex = baseRoles.indexOf(gameState.forcedRoles[p.id]);
              if (roleIndex !== -1) {
                  p.role = baseRoles.splice(roleIndex, 1)[0];
              }
          }
      });

      // 剩下的身份隨機分配
      const remainingRoles = [...baseRoles].sort(() => Math.random() - 0.5);
      gameState.players.forEach(p => {
          if (!p.role) {
              p.role = remainingRoles.pop();
          }
          sendToPlayer(p.id, { type: 'ROLE_ASSIGN', role: p.role });
      });
  };

  const initGame = () => {
      gameState.status = STATUS.NIGHT_WOLF;
      assignRoles();
      gameState.forcedRoles = {}; // 重置
      broadcast("The game has started! Roles have been assigned.");
      setTimeout(startNightCycle, 3000);
  };

  const startNightCycle = () => {
      gameState.nightKilled = null;
      gameState.nightPoisoned = null;
      gameState.wolfVotes = {};
      transitionTo(STATUS.NIGHT_WOLF, "The village falls asleep. Wolves, wake up!");

      // 機器人狼人邏輯：1秒決策
      const botWolves = gameState.players.filter(p => p.role === ROLES.WEREWOLF && p.isAlive && p.isBot);
      botWolves.forEach(bot => {
          setTimeout(() => {
              if (gameState.status !== STATUS.NIGHT_WOLF) return;
              const alive = gameState.players.filter(p => p.isAlive && p.role !== ROLES.WEREWOLF);
              if (alive.length > 0) {
                  const targetSeat = alive[Math.floor(Math.random() * alive.length)].seat;
                  gameState.wolfVotes[bot.seat] = targetSeat;
                  const wolfIds = gameState.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
                  io.to(wolfIds).emit('game_update', { message: `[WOLF] 機器人 ${bot.seat} 號投票擊殺玩家 ${targetSeat}`, state: gameState });
              }
          }, 1000);
      });

      const hasHumanWolf = gameState.players.some(p => p.role === ROLES.WEREWOLF && p.isAlive && !p.isBot);
      const phaseDuration = hasHumanWolf ? 30000 : 3000;

      setTimeout(() => {
          if (gameState.status !== STATUS.NIGHT_WOLF) return;
          
          // 計算狼人票數
          const voteCounts = {};
          Object.values(gameState.wolfVotes).forEach(target => {
              voteCounts[target] = (voteCounts[target] || 0) + 1;
          });
          
          let maxVotes = 0;
          let maxTargets = [];
          for (const [target, count] of Object.entries(voteCounts)) {
              if (count > maxVotes) {
                  maxVotes = count;
                  maxTargets = [parseInt(target)];
              } else if (count === maxVotes) {
                  maxTargets.push(parseInt(target));
              }
          }

          if (maxTargets.length > 0) {
              // 有投票，若平票則隨機
              gameState.nightKilled = maxTargets[Math.floor(Math.random() * maxTargets.length)];
          } else {
              // 沒人投票，隨機殺人
              const alive = gameState.players.filter(p => p.isAlive);
              gameState.nightKilled = alive[Math.floor(Math.random() * alive.length)].seat;
          }
          
          startSeerPhase();
      }, phaseDuration);
  };

  const startSeerPhase = () => {
      transitionTo(STATUS.NIGHT_SEER, "Seer, wake up and examine someone.");
      const hasHumanSeer = gameState.players.some(p => p.role === ROLES.SEER && p.isAlive && !p.isBot);
      const phaseDuration = hasHumanSeer ? 15000 : 3000;

      // 機器人預言家不需要任何行動，只是等待
      setTimeout(() => {
          if (gameState.status !== STATUS.NIGHT_SEER) return;
          startWitchPhase();
      }, phaseDuration);
  };

  const startWitchPhase = () => {
      transitionTo(STATUS.NIGHT_WITCH, "Witch, your turn to brew.");
      const witch = gameState.players.find(p => p.role === ROLES.WITCH && p.isAlive);
      if (witch) {
          if (witch.isBot) {
              setTimeout(() => {
                  if (gameState.status !== STATUS.NIGHT_WITCH) return;
                  if (gameState.witchHasSave && gameState.nightKilled !== null) {
                      if (Math.random() > 0.5) {
                          gameState.nightKilled = null;
                          gameState.witchHasSave = false;
                      }
                  } else if (gameState.witchHasPoison) {
                      if (Math.random() > 0.7) {
                          const alive = gameState.players.filter(p => p.isAlive && p.seat !== witch.seat);
                          if (alive.length > 0) {
                              gameState.nightPoisoned = alive[Math.floor(Math.random() * alive.length)].seat;
                              gameState.witchHasPoison = false;
                          }
                      }
                  }
              }, 1000); // 1秒決策
          } else {
              if (gameState.witchHasSave) {
                  sendToPlayer(witch.id, { type: 'WITCH_PROMPT', action: 'SAVE', target: gameState.nightKilled, msg: `The wolves killed Player ${gameState.nightKilled}.\nSave? (Y/N)` });
              }
              if (gameState.witchHasPoison) {
                  sendToPlayer(witch.id, { type: 'WITCH_PROMPT', action: 'POISON', msg: "Poison someone? (Enter seat or 0)" });
              }
          }
      }
      
      const hasHumanWitch = witch && !witch.isBot;
      const phaseDuration = hasHumanWitch ? 20000 : 3000;

      setTimeout(() => {
          if (gameState.status !== STATUS.NIGHT_WITCH) return;
          startDayPhase();
      }, phaseDuration);
  };

  const startDayPhase = () => {
      transitionTo(STATUS.DAY_ANNOUNCE, "The sun rises...");
      let deadThisNight = [];
      if (gameState.nightKilled) {
          const p = gameState.players.find(p => p.seat === gameState.nightKilled);
          if (p) { p.isAlive = false; deadThisNight.push(p.name); }
      }
      if (gameState.nightPoisoned) {
          const p = gameState.players.find(p => p.seat === gameState.nightPoisoned);
          if (p && p.isAlive) { p.isAlive = false; deadThisNight.push(p.name); }
      }
      broadcast(deadThisNight.length > 0 ? `Last night, ${deadThisNight.join(' and ')} died.` : "Peaceful night. No one died.");
      setTimeout(() => {
          const winner = checkWinCondition();
          if (winner) transitionTo(STATUS.GAMEOVER, `GAME OVER! Winner: ${winner === 'GOOD_WIN' ? 'Citizens' : 'Werewolves'}`);
          else startSpeechPhase();
      }, 5000);
  };

  const startSpeechPhase = () => {
      transitionTo(STATUS.DAY_SPEECH, "Discussion phase. Wait for your turn.");
      const alivePlayers = gameState.players.filter(p => p.isAlive);
      let speakerIdx = 0;
      const runSpeechCycle = async () => {
          if (gameState.status !== STATUS.DAY_SPEECH) return;
          const current = alivePlayers[speakerIdx];
          if (!current) return;
          gameState.currentSpeaker = current.seat;
          gameState.speechEndTime = Date.now() + 45000;
          broadcast(`Player ${current.seat}'s (${current.name}) turn to speak. (45s)`);
          
          if (current.isBot) {
              await new Promise(res => setTimeout(res, 2000)); // 模擬打字延遲
              if (gameState.status === STATUS.DAY_SPEECH && gameState.currentSpeaker === current.seat) {
                  broadcast(`[🗣️ 發言] ${current.name}: ${getBotSpeech()}`);
              }
              await new Promise(res => setTimeout(res, 1000)); // 發言後等1秒就跳過
          } else {
              sendToPlayer(current.id, { type: 'SPEECH_UNLOCK' });
              await new Promise(res => {
                  let skipped = false;
                  const timer = setTimeout(() => {
                      if (!skipped) {
                          skipped = true;
                          gameState.skipSpeech = null;
                          res();
                      }
                  }, 45000);
                  
                  gameState.skipSpeech = () => {
                      if (!skipped) {
                          skipped = true;
                          clearTimeout(timer);
                          gameState.skipSpeech = null;
                          res();
                      }
                  };
              });
          }

          if (gameState.status === STATUS.DAY_SPEECH) {
              speakerIdx++;
              if (speakerIdx >= alivePlayers.length) startVotingPhase();
              else runSpeechCycle();
          }
      };
      runSpeechCycle();
  };

  const startVotingPhase = () => {
      transitionTo(STATUS.DAY_VOTE, "Vote for the wolf!");
      gameState.votes = {};

      // 機器人投票邏輯
      gameState.players.filter(p => p.isAlive && p.isBot).forEach(bot => {
          setTimeout(() => {
              if (gameState.status !== STATUS.DAY_VOTE) return;
              const alive = gameState.players.filter(p => p.isAlive && p.seat !== bot.seat);
              if (alive.length > 0) {
                  const target = alive[Math.floor(Math.random() * alive.length)].seat;
                  gameState.votes[bot.seat] = target;
                  broadcast(`Player ${bot.seat} voted for ${target}`);
              }
          }, Math.random() * 5000 + 2000);
      });

      setTimeout(() => {
          if (gameState.status !== STATUS.DAY_VOTE) return;
          const counts = {};
          Object.values(gameState.votes).forEach(v => counts[v] = (counts[v] || 0) + 1);
          let maxVotes = 0, exiledSeat = null;
          for (let seat in counts) { if (counts[seat] > maxVotes) { maxVotes = counts[seat]; exiledSeat = parseInt(seat); } }
          if (exiledSeat) {
              const victim = gameState.players.find(p => p.seat === exiledSeat);
              victim.isAlive = false;
              broadcast(`Player ${exiledSeat} (${victim.name}) was exiled!`);
              if (victim.role === ROLES.HUNTER) {
                  broadcast("The exiled was the HUNTER! He shoots someone!");
                  if (victim.isBot) {
                      setTimeout(() => {
                          const alive = gameState.players.filter(p => p.isAlive);
                          if (alive.length > 0) {
                              const target = alive[Math.floor(Math.random() * alive.length)];
                              target.isAlive = false;
                              broadcast(`Hunter shot Player ${target.seat}!`);
                          }
                          setTimeout(() => {
                              const winner = checkWinCondition();
                              if (winner) transitionTo(STATUS.GAMEOVER, `GAME OVER! Winner: ${winner === 'GOOD_WIN' ? 'Citizens' : 'Werewolves'}`);
                              else startNightCycle();
                          }, 3000); // 縮短流程
                      }, 1000); // 1秒決策
                  } else {
                      sendToPlayer(victim.id, { type: 'SHOOT_PROMPT', msg: "Who to shoot? (Seat number)" });
                      setTimeout(() => startNightCycle(), 10000);
                  }
                  return;
              }
          } else { broadcast("No one was exiled."); }
          setTimeout(() => {
              const winner = checkWinCondition();
              if (winner) transitionTo(STATUS.GAMEOVER, `GAME OVER! Winner: ${winner === 'GOOD_WIN' ? 'Citizens' : 'Werewolves'}`);
              else startNightCycle();
          }, 5000);
      }, 30000);
  };

  // ==========================================
  // Socket 處理與驗證
  // ==========================================
  io.on('connection', (socket) => {
      socket.on('join_game', (name) => {
          if (gameState.players.length >= 9) return sendToPlayer(socket.id, { error: "Room full" });
          const seat = gameState.players.length + 1;
          gameState.players.push({ id: socket.id, seat, name, role: null, isAlive: true, isBot: false });
          broadcast(`Player ${name} joined as Seat ${seat}.`);
          if (gameState.players.length === 9) {
              broadcast("All players joined. Game starting in 3 seconds...");
              setTimeout(() => {
                  if (gameState.status === STATUS.WAITING) initGame();
              }, 3000);
          }
      });

      socket.on('add_bot', () => {
          if (gameState.players.length >= 9) return;
          const seat = gameState.players.length + 1;
          const name = `機器人 ${seat} 號`;
          gameState.players.push({ id: `BOT_${seat}`, seat, name, role: null, isAlive: true, isBot: true });
          broadcast(`Player ${name} joined as Seat ${seat}.`);
          if (gameState.players.length === 9) {
              broadcast("All players joined. Game starting in 3 seconds...");
              setTimeout(() => {
                  if (gameState.status === STATUS.WAITING) initGame();
              }, 3000);
          }
      });

      socket.on('start_game', () => {
          if (gameState.players.length === 9 && gameState.status === STATUS.WAITING) initGame();
      });

      socket.on('force_role', (role) => {
          if (gameState.status === STATUS.WAITING) {
              if (role === 'RANDOM') {
                  delete gameState.forcedRoles[socket.id];
              } else {
                  gameState.forcedRoles[socket.id] = role;
              }
              sendToPlayer(socket.id, { msg: `系統提示：你已將自己的身分指定為 ${role === 'RANDOM' ? '隨機' : role}` });
          }
      });

      socket.on('end_speech', () => {
          const player = gameState.players.find(p => p.id === socket.id);
          if (player && gameState.status === STATUS.DAY_SPEECH && gameState.currentSpeaker === player.seat) {
              if (gameState.skipSpeech) {
                  gameState.skipSpeech();
              }
          }
      });

      socket.on('game_action', (data) => {
          const player = gameState.players.find(p => p.id === socket.id);
          if (!player || !player.isAlive) return;
          const { cmd, target } = data;
          if (cmd === 'kill' && gameState.status === STATUS.NIGHT_WOLF && player.role === ROLES.WEREWOLF) {
              const targetSeat = parseInt(target);
              const targetPlayer = gameState.players.find(p => p.seat === targetSeat && p.isAlive);
              if (targetPlayer && targetPlayer.role !== ROLES.WEREWOLF) {
                  gameState.wolfVotes[player.seat] = targetSeat;
                  const wolfIds = gameState.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
                  io.to(wolfIds).emit('game_update', { message: `[WOLF] 玩家 ${player.name} 投票擊殺玩家 ${targetSeat}`, state: gameState });
              } else {
                  sendToPlayer(socket.id, { error: "Invalid target." });
              }
          } else if (cmd === 'check' && gameState.status === STATUS.NIGHT_SEER && player.role === ROLES.SEER) {
              const targetPlayer = gameState.players.find(p => p.seat === target);
              sendToPlayer(socket.id, { msg: `Player ${target} is ${targetPlayer?.role === ROLES.WEREWOLF ? 'WEREWOLF' : 'GOOD'}` });
          } else if (cmd === 'witch_action' && gameState.status === STATUS.NIGHT_WITCH && player.role === ROLES.WITCH) {
              if (data.action === 'SAVE' && gameState.witchHasSave) { gameState.nightKilled = null; gameState.witchHasSave = false; sendToPlayer(socket.id, { msg:
  "Saved!" }); }
              if (data.action === 'SAVE' && gameState.witchHasSave) { gameState.nightKilled = null; gameState.witchHasSave = false; sendToPlayer(socket.id, { msg: "Saved!" }); }
              else if (data.action === 'POISON' && gameState.witchHasPoison && target !== 0) { gameState.nightPoisoned = target; gameState.witchHasPoison = false; sendToPlayer(socket.id, { msg: `Poisoned ${target}` }); }
          } else if (cmd === 'vote' && gameState.status === STATUS.DAY_VOTE) {
              gameState.votes[player.seat] = target;
              broadcast(`Player ${player.seat} voted for ${target}`);
          } else if (cmd === 'shoot' && player.role === ROLES.HUNTER) {
              const targetPlayer = gameState.players.find(p => p.seat === target);
              if (targetPlayer) {
                  targetPlayer.isAlive = false;
                  broadcast(`Hunter shot Player ${target}!`);
                  setTimeout(() => {
                      const winner = checkWinCondition();
                      if (winner) transitionTo(STATUS.GAMEOVER, `GAME OVER! Winner: ${winner === 'GOOD_WIN' ? 'Citizens' : 'Werewolves'}`);
                      else startNightCycle();
                  }, 5000);
              }
          }
      });

      socket.on('chat_message', (msg) => {
          const player = gameState.players.find(p => p.id === socket.id);
          if (!player || !player.isAlive) return;
          if (gameState.status === STATUS.NIGHT_WOLF && player.role === ROLES.WEREWOLF) {
              const wolfIds = gameState.players.filter(p => p.role === ROLES.WEREWOLF).map(p => p.id);
              io.to(wolfIds).emit('game_update', { message: `[WOLF] ${player.name}: ${msg}`, state: gameState });
          } else if (gameState.status === STATUS.DAY_SPEECH && gameState.currentSpeaker === player.seat) {
              const now = Date.now();
              if (player.lastSpeechTime && now - player.lastSpeechTime < 3000) {
                  sendToPlayer(socket.id, { msg: "系統提示：請等待 3 秒後再發言！" });
                  return;
              }
              player.lastSpeechTime = now;
              broadcast(`[🗣️ 發言] ${player.name}: ${msg}`);
          } else {
              sendToPlayer(socket.id, { error: "You cannot speak right now!" });
          }
      });

      socket.on('disconnect', () => {
          const player = gameState.players.find(p => p.id === socket.id);
          if (player) player.isAlive = false;
      });
  });

  // Serve static files
  app.use(express.static(path.join(__dirname)));

  app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'index.html'));
  });

  // Start server
  const PORT = process.env.PORT || 3001;
  server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
  });
