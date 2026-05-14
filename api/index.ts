import express from 'express';
import axios from 'axios';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();

// Konfigurasi Environment Variables di Vercel Dashboard nanti
const CLIENT_ID = process.env.CANVA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.CANVA_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.CANVA_REDIRECT_URI || '';

// Perhatian: Di Vercel (Serverless), variabel ini akan reset saat fungsi idle/cold start.
// Jika Kiro AI gagal membuat desain, cukup akses endpoint /login kembali.
let CANVA_ACCESS_TOKEN: string | null = null;

app.get('/login', (req, res) => {
    const scopes = 'design:content:read design:content:write design:meta:read asset:read';
    const authUrl = `https://www.canva.com/api/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    const authorizationCode = req.query.code;
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
        res.send('Autentikasi Canva Berhasil! Silakan kembali ke Kiro AI.');
    } catch (error: any) {
        console.error('[ERROR] Autentikasi gagal:', error.response?.data || error.message);
        res.status(500).send('Gagal menukar token dengan Canva.');
    }
});

// Setup MCP Server
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
            return { content: [{ type: "text", text: `Error: Token Canva tidak ditemukan. Silakan buka kembali URL /login di browser.` }], isError: true };
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

// Setup Transport SSE untuk Kiro AI
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

// Wajib diekspor untuk lingkungan Vercel
export default app;
