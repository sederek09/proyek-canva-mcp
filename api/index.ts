import express from 'express';
import axios from 'axios';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();

const CLIENT_ID = process.env.CANVA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.CANVA_REDIRECT_URI || '';

let CANVA_ACCESS_TOKEN: string | null = null;

// Halaman utama
app.get('/', (req, res) => {
    res.send(`
        <html>
            <body style="background-color: #0d1117; color: #58a6ff; font-family: monospace; padding: 20px;">
                <h2>[SYSTEM ONLINE] Canva MCP Bridge Active</h2>
                <p>Status: Serverless Function is running.</p>
                <p>Client ID Loaded: ${CLIENT_ID ? 'YES' : 'NO (Check Vercel Env)'}</p>
                <p>Client Secret Loaded: ${CLIENT_SECRET ? 'YES' : 'NO (Check Vercel Env)'}</p>
                <p>Redirect URI Loaded: ${REDIRECT_URI ? 'YES' : 'NO (Check Vercel Env)'}</p>
                <hr style="border-color: #30363d;">
                <p>Action Required:</p>
                <ul>
                    <li>Access <a href="/login" style="color: #3fb950;">/login</a> to authenticate with Canva.</li>
                    <li>Use <span style="color: #f0ad4e;">/mcp</span> as the connection URL in Kiro AI.</li>
                </ul>
            </body>
        </html>
    `);
});

// Endpoint untuk login
app.get('/login', (req, res) => {
    if (!CLIENT_ID || !REDIRECT_URI) {
        return res.status(500).send("SYSTEM ERROR: CANVA_CLIENT_ID atau CANVA_REDIRECT_URI belum terbaca dari server Vercel.");
    }
    
    const scopes = 'design:content:read design:content:write design:meta:read asset:read';
    const authUrl = `https://www.canva.com/api/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});

// Endpoint Callback dari Canva
app.get('/callback', async (req, res) => {
    const authorizationCode = req.query.code;
    const errorFromCanva = req.query.error;
    const errorDescription = req.query.error_description;

    // Menangkap error jika user menolak atau Canva menolak permintaan
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

    try {
        const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
        const tokenResponse = await axios.post('https://api.canva.com/rest/v1/oauth/token', 
            new URLSearchParams({
                grant_type: 'authorization_code',
                code: authorizationCode as string,
                redirect_uri: REDIRECT_URI
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
                    <p>Otorisasi Canva berhasil. Server MCP sekarang memiliki izin akses.</p>
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
                <p>Detail Error dari Canva API:</p>
                <pre style="background: #161b22; padding: 15px; border-radius: 5px;">${JSON.stringify(errorDetail, null, 2)}</pre>
                <p>Saran perbaikan: Periksa kembali apakah CLIENT_SECRET sudah benar dan Anda sudah melakukan Redeploy di Vercel.</p>
            </body>
        `);
    }
});

// Konfigurasi MCP
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
