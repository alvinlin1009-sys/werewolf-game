const { io } = require("socket.io-client");
const socket = io("http://localhost:3001");

socket.on("connect", () => {
    console.log("Connected to server");
    socket.emit("create_room", "Tester");
});

socket.on("game_update", (data) => {
    console.log("Update:", data.message || "State change", data.state.status);
    if (data.state.status === 'WAITING' && data.state.players.length === 1) {
        for (let i = 0; i < 8; i++) socket.emit("add_bot");
    }
    
    if (data.state.status === 'DAY_SPEECH') {
        if (data.state.currentSpeaker === 1) {
            console.log("My turn to speak, skipping...");
            socket.emit("end_speech");
        }
    }
    
    if (data.state.status === 'DAY_VOTE') {
        console.log("Voting phase! Emitting vote...");
        socket.emit("game_action", { cmd: "vote", target: "2" });
    }
});

socket.on("private_msg", (data) => {
    console.log("Private msg:", data);
});

setTimeout(() => {
    console.log("Test finished");
    process.exit(0);
}, 60000);
