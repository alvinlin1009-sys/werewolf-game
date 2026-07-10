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
      nightKilled: null,
      nightPoisoned: null,
      votes: {},
  };

  // ==========================================
  // 工具函數
  // ==========================================
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

  const initGame = () => {
      const rolePool = [...Array(3).fill(ROLES.WEREWOLF), ...Array(3).fill(ROLES.VILLAGER), ROLES.SEER, ROLES.WITCH, ROLES.HUNTER];
      rolePool.sort(() => Math.random() - 0.5);
      gameState.players.forEach((p, index) => {
          p.role = rolePool[index];
          sendToPlayer(p.id, { type: 'ROLE_ASSIGN', role: p.role });
      });
      startNightCycle();
  };

  const startNightCycle = () => {
      gameState.nightKilled = null;
      gameState.nightPoisoned = null;
      transitionTo(STATUS.NIGHT_WOLF, "The village falls asleep. Wolves, wake up!");
      setTimeout(() => {
          if (gameState.status !== STATUS.NIGHT_WOLF) return;
          if (gameState.nightKilled === null) {
              const alive = gameState.players.filter(p => p.isAlive);
              gameState.nightKilled = alive[Math.floor(Math.random() * alive.length)].seat;
          }
          startSeerPhase();
      }, 30000);
  };

  const startSeerPhase = () => {
      transitionTo(STATUS.NIGHT_SEER, "Seer, wake up and examine someone.");
      setTimeout(() => {
          if (gameState.status !== STATUS.NIGHT_SEER) return;
          startWitchPhase();
      }, 15000);
  };

  const startWitchPhase = () => {
      transitionTo(STATUS.NIGHT_WITCH, "Witch, your turn to brew.");
      const witch = gameState.players.find(p => p.role === ROLES.WITCH && p.isAlive);
      if (witch) {
          if (gameState.witchHasSave) {
              sendToPlayer(witch.id, { type: 'WITCH_PROMPT', action: 'SAVE', target: gameState.nightKilled, msg: `The wolves killed Player ${gameState.nightKilled}.
  Save? (Y/N)` });
          }
          if (gameState.witchHasPoison) {
              sendToPlayer(witch.id, { type: 'WITCH_PROMPT', action: 'POISON', msg: "Poison someone? (Enter seat or 0)" });
          }
      }
      setTimeout(() => {
          if (gameState.status !== STATUS.NIGHT_WITCH) return;
          startDayPhase();
      }, 20000);
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
          const current = alivePlayers[speakerIdx % alivePlayers.length];
          if (!current) return;
          gameState.currentSpeaker = current.seat;
          broadcast(`Player ${current.seat}'s (${current.name}) turn to speak. (45s)`);
          sendToPlayer(current.id, { type: 'SPEECH_UNLOCK' });
          await new Promise(res => setTimeout(res, 45000));
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
                  sendToPlayer(victim.id, { type: 'SHOOT_PROMPT', msg: "Who to shoot? (Seat number)" });
                  setTimeout(() => startNightCycle(), 10000);
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
          gameState.players.push({ id: socket.id, seat, name, role: null, isAlive: true });
          broadcast(`Player ${name} joined as Seat ${seat}.`);
          if (gameState.players.length === 9) broadcast("All players joined. Host, please start.");
      });

      socket.on('start_game', () => {
          if (gameState.players.length === 9 && gameState.status === STATUS.WAITING) initGame();
      });

      socket.on('game_action', (data) => {
          const player = gameState.players.find(p => p.id === socket.id);
          if (!player || !player.isAlive) return;
          const { cmd, target } = data;
          if (cmd === 'kill' && gameState.status === STATUS.NIGHT_WOLF && player.role === ROLES.WEREWOLF) {
              gameState.nightKilled = target;
              sendToPlayer(socket.id, { msg: `You voted to kill ${target}` });
          } else if (cmd === 'check' && gameState.status === STATUS.NIGHT_SEER && player.role === ROLES.SEER) {
              const targetPlayer = gameState.players.find(p => p.seat === target);
              sendToPlayer(socket.id, { msg: `Player ${target} is ${targetPlayer?.role === ROLES.WEREWOLF ? 'WEREWOLF' : 'GOOD'}` });
          } else if (cmd === 'witch_action' && gameState.status === STATUS.NIGHT_WITCH && player.role === ROLES.WITCH) {
              if (data.action === 'SAVE' && gameState.witchHasSave) { gameState.nightKilled = null; gameState.witchHasSave = false; sendToPlayer(socket.id, { msg:
  "Saved!" }); }
              else if (data.action === 'POISON' && gameState.witchHasPoison && target !== 0) { gameState.nightPoisoned = target; gameState.witchHasPoison = false;
  sendToPlayer(socket.id, { msg: `Poisoned ${target}` }); }
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
              broadcast(`${player.name}: ${msg}`);
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
