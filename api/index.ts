import express from 'express';
import axios from 'axios';
import crypto from 'crypto';

const app = express();

const CLIENT_ID = (process.env.CANVA_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.CANVA_CLIENT_SECRET || '').trim();
const REDIRECT_URI = (process.env.CANVA_REDIRECT_URI || '').trim();

function generateCodeVerifier() { return crypto.randomBytes(32).toString('base64url'); }
function generateCodeChallenge(verifier: string) { return crypto.createHash('sha256').update(verifier).digest('base64url'); }
const getCookie = (cookieHeader: string | undefined, name: string) => {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
};

app.get('/', (req, res) => {
    res.send(`<h2>[VERCEL TOKEN GENERATOR]</h2><p><a href="/login">Klik di sini untuk Login Canva</a></p>`);
});

app.get('/login', (req, res) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    res.cookie('canva_code_verifier', codeVerifier, { maxAge: 10 * 60 * 1000, httpOnly: true, secure: true });
    
    // Offline_access memastikan kita dapat refresh token
    const scopes = 'offline_access folder:write design:permission:read design:content:write design:permission:write folder:read brandtemplate:content:write app:read design:content:read brandtemplate:meta:read comment:read folder:permission:write comment:write app:write brandtemplate:content:read profile:read asset:write design:meta:read folder:permission:read asset:read';
    const authUrl = `https://www.canva.com/api/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&code_challenge=${codeChallenge}&code_challenge_method=s256`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const authorizationCode = req.query.code;
    const codeVerifier = getCookie(req.headers.cookie, 'canva_code_verifier');
    
    if (!authorizationCode || !codeVerifier) return res.status(400).send('Error: Code atau Verifier hilang.');

    try {
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenResponse = await axios.post('https://api.canva.com/rest/v1/oauth/token', 
            new URLSearchParams({ grant_type: 'authorization_code', code: authorizationCode as string, redirect_uri: REDIRECT_URI, code_verifier: codeVerifier }).toString(), 
            { headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
        );

        res.send(`
            <body style="background-color: #0d1117; color: #fff; font-family: monospace; padding: 20px;">
                <h2 style="color: #3fb950;">SISTEM OTOMATISASI SIAP!</h2>
                <p>Copy <b>REFRESH TOKEN</b> di bawah ini dan masukkan ke Kiro AI. Anda tidak perlu lagi copy Access Token setiap 4 jam.</p>
                <textarea style="width: 100%; height: 100px; background: #161b22; color: #f0ad4e; padding: 10px; border: 1px solid #3fb950;" readonly>${tokenResponse.data.refresh_token}</textarea>
            </body>
        `);
    } catch (error: any) {
        res.status(500).send(`Error: ${error.message}`);
    }
});

export default app;
