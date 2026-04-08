const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let rtpBandar = { roulette: 40, coinflip: 40, spinwheel: 30 };

// SETTINGAN DATABASE KHUSUS RAILWAY (ANTI KERESET)
const dbPath = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'lgolux.db') : './lgolux.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error(err.message);
    else console.log(`✅ Brankas Database Terkunci di: ${dbPath}`);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'member', coin INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, amount INTEGER, status TEXT DEFAULT 'PENDING')`);
    
    bcrypt.hash('admin123', 10, (err, hash) => {
        db.run(`INSERT OR IGNORE INTO users (username, password, role, coin) VALUES ('admin', ?, 'admin', 9999999)`, [hash]);
    });
});

const sessionMiddleware = session({ secret: 'lgolux-rahasia-jp', resave: false, saveUninitialized: true });
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.engine.use(sessionMiddleware);

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/register', (req, res) => {
    const { username, password, role } = req.body;
    const userRole = role === 'admin' && req.session.role === 'admin' ? 'admin' : 'member'; 
    bcrypt.hash(password, 10, (err, hash) => {
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hash, userRole], function(err) {
            if (err) return res.json({ success: false, msg: 'Username sudah dipakai bosku!' });
            res.json({ success: true, msg: 'Akun berhasil dibuat!' });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, msg: 'User tidak ditemukan!' });
        bcrypt.compare(password, user.password, (err, match) => {
            if (!match) return res.json({ success: false, msg: 'Password salah bosku!' });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            res.json({ success: true, role: user.role });
        });
    });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    db.get(`SELECT username, role, coin FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (user) res.json({ loggedIn: true, ...user });
        else res.json({ loggedIn: false });
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;

    socket.join(`user_${session.userId}`);
    if (session.role === 'admin') socket.join('admins');

    socket.on('get_rtp', () => { if (session.role === 'admin') socket.emit('rtp_data', rtpBandar); });
    socket.on('update_rtp', (newRtp) => {
        if (session.role === 'admin') { rtpBandar = newRtp; io.to('admins').emit('rtp_data', rtpBandar); socket.emit('deposit_msg', '😈 Win Rate (RTP) Bandar Berhasil Diperbarui!'); }
    });

    socket.on('req_deposit', (amount) => {
        db.run(`INSERT INTO deposits (user_id, username, amount) VALUES (?, ?, ?)`, [session.userId, session.username, amount], function() {
            io.to('admins').emit('admin_new_deposit');
            socket.emit('deposit_msg', `✅ Request ${amount.toLocaleString()} Koin terkirim. Menunggu Admin!`);
        });
    });

    socket.on('admin_approve_deposit', (id) => {
        if (session.role !== 'admin') return;
        db.get(`SELECT * FROM deposits WHERE id = ? AND status = 'PENDING'`, [id], (err, dep) => {
            if (!dep) return;
            db.run(`UPDATE deposits SET status = 'SUCCESS' WHERE id = ?`, [id]);
            db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [dep.amount, dep.user_id], () => {
                db.get(`SELECT coin FROM users WHERE id = ?`, [dep.user_id], (err, user) => {
                    io.to(`user_${dep.user_id}`).emit('update_coin', user.coin);
                    io.to(`user_${dep.user_id}`).emit('deposit_msg', `🎉 Deposit ${dep.amount.toLocaleString()} Koin Di-Approve!`);
                });
                socket.emit('deposit_approved_success');
            });
        });
    });

    socket.on('get_pending_deposits', () => {
        if (session.role !== 'admin') return;
        db.all(`SELECT * FROM deposits WHERE status = 'PENDING'`, (err, rows) => socket.emit('admin_deposit_list', rows));
    });

    socket.on('play_roulette', (data) => {
        const { betAmount, color } = data;
        if (betAmount <= 0) return socket.emit('game_result', { game: 'roulette', status: 'error', msg: 'Taruhan gak valid!' });
        db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.coin < betAmount) return socket.emit('game_result', { game: 'roulette', status: 'error', msg: 'Koin kurang bosku!' });
            const newCoin = user.coin - betAmount;
            db.run(`UPDATE users SET coin = ? WHERE id = ?`, [newCoin, session.userId], () => {
                socket.emit('update_coin', newCoin);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.roulette / 100);
                    const resultColor = isWin ? color : (color === 'merah' ? 'hitam' : 'merah');
                    if (isWin) {
                        const winAmount = betAmount * 2;
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [winAmount, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, updatedUser) => {
                                io.to(`user_${session.userId}`).emit('update_coin', updatedUser.coin);
                                socket.emit('game_result', { game: 'roulette', status: 'win', msg: `🎉 WIN! Keluar ${resultColor.toUpperCase()}` });
                            });
                        });
                    } else socket.emit('game_result', { game: 'roulette', status: 'lose', msg: `💀 ZONK! Keluar ${resultColor.toUpperCase()}` });
                }, 1500); 
            });
        });
    });

    socket.on('play_coinflip', (data) => {
        const { betAmount, guess } = data;
        if (betAmount <= 0) return socket.emit('game_result', { game: 'coinflip', status: 'error', msg: 'Taruhan gak valid!' });
        db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.coin < betAmount) return socket.emit('game_result', { game: 'coinflip', status: 'error', msg: 'Koin kurang!' });
            const newCoin = user.coin - betAmount;
            db.run(`UPDATE users SET coin = ? WHERE id = ?`, [newCoin, session.userId], () => {
                socket.emit('update_coin', newCoin);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.coinflip / 100);
                    const result = isWin ? guess : (guess === 'angka' ? 'gambar' : 'angka');
                    if (isWin) {
                        const winAmount = Math.floor(betAmount * 1.9);
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [winAmount, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, updatedUser) => {
                                io.to(`user_${session.userId}`).emit('update_coin', updatedUser.coin);
                                socket.emit('game_result', { game: 'coinflip', status: 'win', msg: `🎉 JP! Mendarat di ${result.toUpperCase()}` });
                            });
                        });
                    } else socket.emit('game_result', { game: 'coinflip', status: 'lose', msg: `💀 ZONK! Mendarat di ${result.toUpperCase()}` });
                }, 1500); 
            });
        });
    });

    socket.on('play_spinwheel', (betAmount) => {
        if (betAmount <= 0) return socket.emit('game_result', { game: 'spinwheel', status: 'error', msg: 'Taruhan gak valid!' });
        db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.coin < betAmount) return socket.emit('game_result', { game: 'spinwheel', status: 'error', msg: 'Koin kurang!' });
            const newCoin = user.coin - betAmount;
            db.run(`UPDATE users SET coin = ? WHERE id = ?`, [newCoin, session.userId], () => {
                socket.emit('update_coin', newCoin);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.spinwheel / 100);
                    let randMulti;
                    if (isWin) {
                        const winMultis = [1.5, 2, 5]; 
                        randMulti = winMultis[Math.floor(Math.random() * winMultis.length)];
                    } else {
                        const loseMultis = [0, 0, 0.5, 1];
                        randMulti = loseMultis[Math.floor(Math.random() * loseMultis.length)];
                    }
                    const winAmount = Math.floor(betAmount * randMulti);
                    if (winAmount > 0) {
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [winAmount, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, updatedUser) => {
                                io.to(`user_${session.userId}`).emit('update_coin', updatedUser.coin);
                                socket.emit('game_result', { game: 'spinwheel', status: randMulti >= 2 ? 'win' : 'lose', msg: `🎡 x${randMulti} ! Dapat ${winAmount.toLocaleString()} Koin.` });
                            });
                        });
                    } else socket.emit('game_result', { game: 'spinwheel', status: 'lose', msg: `🎡 ZONK! Berhenti di [ x0 ]` });
                }, 2000); 
            });
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server jalan di port ${PORT}`));
