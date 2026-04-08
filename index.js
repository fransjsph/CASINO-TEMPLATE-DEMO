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

const dbPath = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'lgolux.db') : './lgolux.db';
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'member', coin INTEGER DEFAULT 0, status TEXT DEFAULT 'AKTIF')`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT, type TEXT, amount INTEGER, status TEXT DEFAULT 'PENDING', note TEXT, date DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`ALTER TABLE transactions ADD COLUMN note TEXT`, (err) => {});
    
    bcrypt.hash('admin123', 10, (err, hash) => {
        db.run(`INSERT OR IGNORE INTO users (username, password, role, coin) VALUES ('admin', ?, 'admin', 9999999)`, [hash]);
    });
});

const sessionMiddleware = session({ secret: 'lgolux-rahasia-jp', resave: false, saveUninitialized: true });
app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.engine.use(sessionMiddleware);

app.post('/api/register', (req, res) => {
    const { username, password, role } = req.body;
    const userRole = (role === 'admin' && req.session.role === 'admin') ? 'admin' : 'member'; 
    bcrypt.hash(password, 10, (err, hash) => {
        db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, ?)`, [username, hash, userRole], function(err) {
            if (err) return res.json({ success: false, msg: 'Username sudah dipakai!' });
            res.json({ success: true, msg: 'Akun berhasil dibuat!' });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.json({ success: false, msg: 'User tidak ditemukan!' });
        if (user.status === 'BLOKIR') return res.json({ success: false, msg: 'ID ANDA DIBLOKIR BANDAR!' });
        bcrypt.compare(password, user.password, (err, match) => {
            if (!match) return res.json({ success: false, msg: 'Password salah!' });
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            res.json({ success: true, role: user.role });
        });
    });
});

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    db.get(`SELECT id, username, role, coin, status FROM users WHERE id = ?`, [req.session.userId], (err, user) => {
        if (user) res.json({ loggedIn: true, ...user });
        else res.json({ loggedIn: false });
    });
});

app.get('/api/history', (req, res) => {
    if (!req.session.userId) return res.json([]);
    db.all(`SELECT * FROM transactions WHERE user_id = ? ORDER BY date DESC LIMIT 15`, [req.session.userId], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// ADMIN API
app.get('/api/admin/users', (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).send();
    db.all(`SELECT id, username, coin, status FROM users WHERE role = 'member' ORDER BY id DESC`, (err, rows) => res.json(rows));
});

app.post('/api/admin/update-user', (req, res) => {
    if (req.session.role !== 'admin') return res.status(403).send();
    const { id, coin, status, password, note, username } = req.body;
    db.get(`SELECT coin FROM users WHERE id = ?`, [id], (err, user) => {
        if(!user) return res.json({success: false});
        const diff = coin - user.coin;
        if (diff !== 0) {
            const adjType = diff > 0 ? 'BONUS ADMIN' : 'POTONGAN ADMIN';
            db.run(`INSERT INTO transactions (user_id, username, type, amount, status, note) VALUES (?, ?, ?, ?, 'SUCCESS', ?)`, [id, username, adjType, Math.abs(diff), note || 'Penyesuaian Saldo']);
        }
        if (password && password.trim() !== "") {
            bcrypt.hash(password, 10, (err, hash) => {
                db.run(`UPDATE users SET password = ?, coin = ?, status = ? WHERE id = ?`, [hash, coin, status, id]);
            });
        } else {
            db.run(`UPDATE users SET coin = ?, status = ? WHERE id = ?`, [coin, status, id]);
        }
        res.json({ success: true });
    });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

io.on('connection', (socket) => {
    const session = socket.request.session;
    if (!session || !session.userId) return;

    socket.join(`user_${session.userId}`);
    if (session.role === 'admin') socket.join('admins');

    socket.on('get_rtp', () => { if (session.role === 'admin') socket.emit('rtp_data', rtpBandar); });
    socket.on('update_rtp', (newRtp) => { if (session.role === 'admin') { rtpBandar = newRtp; io.to('admins').emit('rtp_data', rtpBandar); } });

    socket.on('req_deposit', (amount) => {
        db.run(`INSERT INTO transactions (user_id, username, type, amount, status) VALUES (?, ?, 'DEPOSIT', ?, 'PENDING')`, [session.userId, session.username, amount], function() {
            io.to('admins').emit('admin_new_notif');
            socket.emit('notif_msg', `✅ Request ${amount.toLocaleString('id-ID')} terkirim!`);
        });
    });

    socket.on('req_wd', (amount) => {
        db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (!user || user.coin < amount) return socket.emit('notif_msg', '❌ Saldo tidak cukup bosku!');
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [amount, session.userId], () => {
                db.run(`INSERT INTO transactions (user_id, username, type, amount, status) VALUES (?, ?, 'WD', ?, 'PENDING')`, [session.userId, session.username, amount]);
                io.to(`user_${session.userId}`).emit('update_coin', user.coin - amount);
                io.to('admins').emit('admin_new_notif');
                socket.emit('notif_msg', '💸 WD Sedang Diproses Admin!');
            });
        });
    });

    socket.on('admin_approve_tx', (id) => {
        if (session.role !== 'admin') return;
        db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'PENDING'`, [id], (err, tx) => {
            if (!tx) return;
            db.run(`UPDATE transactions SET status = 'SUCCESS' WHERE id = ?`, [id]);
            if (tx.type === 'DEPOSIT') {
                db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [tx.amount, tx.user_id], () => {
                    db.get(`SELECT coin FROM users WHERE id = ?`, [tx.user_id], (err, u) => {
                        io.to(`user_${tx.user_id}`).emit('update_coin', u.coin);
                    });
                });
            }
            socket.emit('deposit_approved_success');
        });
    });

    socket.on('admin_reject_tx', (data) => {
        if (session.role !== 'admin') return;
        const { id, reason } = data;
        db.get(`SELECT * FROM transactions WHERE id = ? AND status = 'PENDING'`, [id], (err, tx) => {
            if (!tx) return;
            db.run(`UPDATE transactions SET status = 'REJECTED', note = ? WHERE id = ?`, [reason, id]);
            if (tx.type === 'WD') {
                db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [tx.amount, tx.user_id], () => {
                    db.get(`SELECT coin FROM users WHERE id = ?`, [tx.user_id], (err, u) => io.to(`user_${tx.user_id}`).emit('update_coin', u.coin));
                });
            }
            socket.emit('deposit_approved_success');
        });
    });

    socket.on('get_pending_deposits', () => {
        if (session.role !== 'admin') return;
        db.all(`SELECT * FROM transactions WHERE status = 'PENDING' ORDER BY date DESC`, (err, rows) => socket.emit('admin_deposit_list', rows));
    });

    // --- GAMES LOGIC DENGAN BUG FIXES ---
    socket.on('play_roulette', (data) => {
        const { betAmount, color } = data;
        if (betAmount > 100000) return socket.emit('game_result', { game: 'roulette', status: 'error', msg: '❌ Maksimal bet 100.000!' });
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR') return;
            if (user.coin < betAmount) return socket.emit('game_result', { game: 'roulette', status: 'error', msg: '❌ Saldo tidak cukup bosku!' });
            const newCoin = user.coin - betAmount;
            db.run(`UPDATE users SET coin = ? WHERE id = ?`, [newCoin, session.userId], () => {
                socket.emit('update_coin', newCoin);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.roulette / 100);
                    const resColor = isWin ? color : (color === 'merah' ? 'hitam' : 'merah');
                    if (isWin) {
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [betAmount * 2, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => {
                                io.to(`user_${session.userId}`).emit('update_coin', u.coin);
                                socket.emit('game_result', { game: 'roulette', status: 'win', msg: `🎉 WIN! Keluar ${resColor.toUpperCase()}` });
                            });
                        });
                    } else socket.emit('game_result', { game: 'roulette', status: 'lose', msg: `💀 ZONK! Keluar ${resColor.toUpperCase()}` });
                }, 1500);
            });
        });
    });

    socket.on('play_coinflip', (data) => {
        const { betAmount, guess } = data;
        if (betAmount > 100000) return socket.emit('game_result', { game: 'coinflip', status: 'error', msg: '❌ Maksimal bet 100.000!' });
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR') return;
            if (user.coin < betAmount) return socket.emit('game_result', { game: 'coinflip', status: 'error', msg: '❌ Saldo tidak cukup bosku!' });
            const newCoin = user.coin - betAmount;
            db.run(`UPDATE users SET coin = ? WHERE id = ?`, [newCoin, session.userId], () => {
                socket.emit('update_coin', newCoin);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.coinflip / 100);
                    const res = isWin ? guess : (guess === 'angka' ? 'gambar' : 'angka');
                    if (isWin) {
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [Math.floor(betAmount * 1.9), session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => {
                                io.to(`user_${session.userId}`).emit('update_coin', u.coin);
                                socket.emit('game_result', { game: 'coinflip', status: 'win', msg: `🎉 JP! Mendarat di ${res.toUpperCase()}` });
                            });
                        });
                    } else socket.emit('game_result', { game: 'coinflip', status: 'lose', msg: `💀 ZONK! Mendarat di ${res.toUpperCase()}` });
                }, 1500);
            });
        });
    });

    socket.on('play_spinwheel', (betAmount) => {
        if (betAmount > 100000) return socket.emit('game_result', { game: 'spinwheel', status: 'error', msg: '❌ Maksimal bet 100.000!' });
        db.get(`SELECT coin, status FROM users WHERE id = ?`, [session.userId], (err, user) => {
            if (user.status === 'BLOKIR') return;
            if (user.coin < betAmount) return socket.emit('game_result', { game: 'spinwheel', status: 'error', msg: '❌ Saldo tidak cukup bosku!' });
            db.run(`UPDATE users SET coin = coin - ? WHERE id = ?`, [betAmount, session.userId], () => {
                socket.emit('update_coin', user.coin - betAmount);
                setTimeout(() => {
                    const isWin = Math.random() < (rtpBandar.spinwheel / 100);
                    let multi = isWin ? [1.5, 2, 5][Math.floor(Math.random()*3)] : [0, 0, 0.5, 1][Math.floor(Math.random()*4)];
                    const win = Math.floor(betAmount * multi);
                    if (win > 0) {
                        db.run(`UPDATE users SET coin = coin + ? WHERE id = ?`, [win, session.userId], () => {
                            db.get(`SELECT coin FROM users WHERE id = ?`, [session.userId], (err, u) => {
                                io.to(`user_${session.userId}`).emit('update_coin', u.coin);
                                socket.emit('game_result', { game: 'spinwheel', status: multi >= 2 ? 'win' : 'lose', msg: `🎡 x${multi}! Dapat ${win.toLocaleString('id-ID')}` });
                            });
                        });
                    } else socket.emit('game_result', { game: 'spinwheel', status: 'lose', msg: `🎡 ZONK! Keluar x0` });
                }, 2000);
            });
        });
    });
});

server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`🚀 LGOLUX LIVE!`));
