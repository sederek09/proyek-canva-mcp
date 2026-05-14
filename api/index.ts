import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();

const CLIENT_ID = (process.env.CANVA_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.CANVA_CLIENT_SECRET || '').trim();
const REDIRECT_URI = (process.env.CANVA_REDIRECT_URI || '').trim();

let CANVA_ACCESS_TOKEN: string | null = null;

// Helper: Fungsi PKCE (Proof Key for Code Exchange)
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string) {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// Helper: Membaca Cookie manual (karena Vercel serverless)
const getCookie = (cookieHeader: string | undefined, name: string) => {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
};

// ==========================================
// 1. SISTEM LOGIN & OAUTH DENGAN PKCE
// ==========================================

app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="background-color: #0d1117; color: #58a6ff; font-family: monospace; padding: 20px;">
                <h2>[SYSTEM ONLINE] Canva MCP Bridge (PKCE Enabled)</h2>
                <p>Status: Serverless Function is running.</p>
                <hr style="border-color: #30363d;">
                <p>Action Required:</p>
                <ul>
                    <li>Access <a href="/login" style="color: #3fb950; font-weight: bold;">/login</a> to authenticate with Canva.</li>
                    <li>Use <span style="color: #f0ad4e;">/mcp</span> as the connection URL in Kiro AI.</li>
                </ul>
            </body>
        </html>
    `);
});

app.get('/login', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
        return res.status(500).send("SYSTEM ERROR: CANVA_CLIENT_ID atau CANVA_REDIRECT_URI belum terbaca dari server Vercel.");
    }
    
    // Generate PKCE Challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    // Simpan verifier di cookie untuk dicek nanti saat /callback
    res.cookie('canva_code_verifier', codeVerifier, { maxAge: 10 * 60 * 1000, httpOnly: true, secure: true });

    // Scopes disesuaikan dengan URL yang Anda berikan
    const scopes = 'folder:write design:permission:read design:content:write design:permission:write folder:read brandtemplate:content:write app:read design:content:read brandtemplate:meta:read comment:read folder:permission:write comment:write app:write brandtemplate:content:read profile:read asset:write design:meta:read folder:permission:read asset:read';
    
    // Buat URL dengan tambahan parameter PKCE
    const authUrl = `https://www.canva.com/api/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}&code_challenge=${codeChallenge}&code_challenge_method=s256`;
    
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const authorizationCode = req.query.code;
    const errorFromCanva = req.query.error;
    const errorDescription = req.query.error_description;

    if (errorFromCanva) {
        return res.status(400).send(`
            <body style="background-color: #0d1117; color: #f85149; font-family: monospace; padding: 20px;">
                <h2>[OAUTH ERROR] Canva menolak otorisasi</h2>
                <p>Error: ${errorFromCanva}</p>
                <p>Deskripsi: ${errorDescription || 'Tidak ada deskripsi tambahan.'}</p>
            </body>
        `);
    }

    if (!authorizationCode) {
        return res.status(400).send('Authorization code tidak ditemukan.');
    }

    // Ambil verifier dari cookie yang kita simpan saat /login
    const codeVerifier = getCookie(req.headers.cookie, 'canva_code_verifier');
    
    if (!codeVerifier) {
        return res.status(400).send(`
            <body style="background-color: #0d1117; color: #f85149; font-family: monospace; padding: 20px;">
                <h2>[PKCE ERROR] Code Verifier Hilang</h2>
                <p>Sistem tidak menemukan session cookie. Pastikan browser Anda mengizinkan cookies dari situs ini, lalu coba buka <b>/login</b> lagi.</p>
            </body>
        `);
    }

    try {
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        
        // Tukar token dengan menyertakan code_verifier
        const tokenResponse = await axios.post('https://api.canva.com/rest/v1/oauth/token', 
            new URLSearchParams({
                grant_type: 'authorization_code',
                code: authorizationCode as string,
                redirect_uri: REDIRECT_URI,
                code_verifier: codeVerifier
            }).toString(), 
            {
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        CANVA_ACCESS_TOKEN = tokenResponse.data.access_token;
        console.log('[SUCCESS] Token berhasil didapatkan.');
        res.send(`
            <html>
                <body style="background-color: #0d1117; color: #3fb950; font-family: monospace; padding: 20px;">
                    <h2>[AUTH SUCCESS] Token Captured</h2>
                    <p>Otorisasi Canva (PKCE) berhasil. Server MCP sekarang memiliki izin akses.</p>
                    <p>Silakan kembali ke aplikasi Kiro AI dan masukkan URL Endpoint MCP Anda.</p>
                </body>
            </html>
        `);
    } catch (error: any) {
        const errorDetail = error.response?.data || error.message;
        console.error('[TOKEN EXCHANGE ERROR]:', errorDetail);
        res.status(500).send(`
            <body style="background-color: #0d1117; color: #f85149; font-family: monospace; padding: 20px;">
                <h2>[SERVER ERROR] Gagal Menukar Token</h2>
                <pre style="background: #161b22; padding: 15px; border-radius: 5px;">${JSON.stringify(errorDetail, null, 2)}</pre>
            </body>
        `);
    }
});

// ==========================================
// 2. SISTEM KIRO AI (MCP SERVER)
// ==========================================

const mcpServer = new McpServer({
    name: "canva-vercel-bridge",
    version: "1.0.0",
});

mcpServer.tool(
    "create_canva_design",
    "Membuat file desain baru di Canva",
    {
        title: z.string().describe("Judul file desain"),
        width: z.number().describe("Lebar dalam pixel"),
        height: z.number().describe("Tinggi dalam pixel"),
    },
    async ({ title, width, height }) => {
        if (!CANVA_ACCESS_TOKEN) {
            return { content: [{ type: "text", text: `Error: Token Canva tidak ditemukan. Silakan buka kembali rute /login di browser.` }], isError: true };
        }
        try {
            const response = await axios.post(
                'https://api.canva.com/rest/v1/designs',
                { title, asset_type: "design", design_type: "custom", width, height },
                { headers: { Authorization: `Bearer ${CANVA_ACCESS_TOKEN}` } }
            );
            return { content: [{ type: "text", text: `Desain berhasil dibuat! URL: ${response.data.urls.edit_url}` }] };
        } catch (error: any) {
            return { content: [{ type: "text", text: `Gagal: ${error.message}` }], isError: true };
        }
    }
);

let transport: SSEServerTransport | null = null;

app.get("/mcp", async (req, res) => {
    transport = new SSEServerTransport("/message", res);
    await mcpServer.connect(transport);
});

app.post("/message", express.json(), async (req, res) => {
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(500).send("MCP Transport belum diinisialisasi.");
    }
});

export default app;
