// WhatsApp Cloud API Webhook untuk AyamTenns Stock Bot
// Deploy di Vercel sebagai serverless function

const GAS_URL = process.env.GAS_URL;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ayamtenns_verify_2026";

// ── Kirim pesan WA ─────────────────────────────────────────────
async function sendWA(to, text) {
  const res = await fetch(`https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    })
  });
  if (!res.ok) {
    const err = await res.text();
    console.error(`sendWA failed [${res.status}]:`, err);
  }
}

// ── Kirim ke Apps Script ────────────────────────────────────────
async function postToGAS(body) {
  try {
    const res = await fetch(GAS_URL, {
      method: "POST",
      body: JSON.stringify(body)
    });
    return res.json();
  } catch (e) {
    console.error("postToGAS error:", e);
    return { ok: false, error: e.message };
  }
}

async function getFromGAS(params) {
  try {
    const url = new URL(GAS_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return res.json();
  } catch (e) {
    console.error("getFromGAS error:", e);
    return { ok: false, error: e.message };
  }
}

// ── Parse pesan input barang masuk ─────────────────────────────
// Format:
// masuk 10/5
// ayam tender 2
// minyak 6
// selesai
function parseInputBarang(lines) {
  const items = [];
  let tanggal = null;

  for (const line of lines) {
    const l = line.trim().toLowerCase();
    if (!l) continue;

    // Cek tanggal: "masuk 10/5" atau "masuk 10/05/26"
    const tglMatch = l.match(/masuk\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
    if (tglMatch) {
      const day = tglMatch[1].padStart(2, "0");
      const month = tglMatch[2].padStart(2, "0");
      const year = tglMatch[3] ? (tglMatch[3].length === 2 ? "20" + tglMatch[3] : tglMatch[3]) : "2026";
      tanggal = `${year}-${month}-${day}`;
      continue;
    }

    // Skip "selesai"
    if (l === "selesai") continue;

    // Parse "nama barang jumlah"
    const parts = l.split(/\s+/);
    if (parts.length >= 2) {
      const jumlah = parseFloat(parts[parts.length - 1].replace(",", "."));
      if (!isNaN(jumlah)) {
        const nama = parts.slice(0, -1).join(" ");
        items.push({ nama, jumlah });
      }
    }
  }

  return { tanggal, items };
}

// ── Cari barang berdasarkan nama (fuzzy match) ──────────────────
function cariBarang(nama, daftarBarang) {
  if (!Array.isArray(daftarBarang)) return null;
  const q = nama.toLowerCase();

  // Exact match dulu
  let found = daftarBarang.find(b => b.nama.toLowerCase() === q);
  if (found) return found;

  // Contains match
  found = daftarBarang.find(b => b.nama.toLowerCase().includes(q));
  if (found) return found;

  // Partial match — semua kata query ada di nama
  const words = q.split(/\s+/);
  found = daftarBarang.find(b => {
    const nameLower = b.nama.toLowerCase();
    return words.every(w => nameLower.includes(w));
  });
  return found || null;
}

// ── Handler utama ───────────────────────────────────────────────
async function handleMessage(from, text) {
  const lines = text.trim().split("\n");
  const firstLine = lines[0].trim().toLowerCase();

  // ── CEK STOK ────────────────────────────────────────
  if (firstLine.startsWith("stok")) {
    const query = firstLine.replace("stok", "").trim();
    const data = await getFromGAS({ action: "getBarang" });
    
    if (!data.ok || !Array.isArray(data.data)) {
      await sendWA(from, "❌ Gagal ambil data stok.");
      return;
    }

    if (!query) {
      // List semua stok rendah
      const rendah = data.data.filter(b => b.stokAkhir <= b.stokMinimum);
      if (rendah.length === 0) {
        await sendWA(from, "✅ Semua stok aman, tidak ada yang di bawah minimum.");
      } else {
        const msg = "⚠️ *Stok di bawah minimum:*\n\n" +
          rendah.map(b => `• ${b.nama}: ${b.stokAkhir} ${b.satuanBeli} (min: ${b.stokMinimum})`).join("\n");
        await sendWA(from, msg);
      }
      return;
    }

    // Cari barang spesifik
    const found = cariBarang(query, data.data);
    if (!found) {
      await sendWA(from, `❌ Barang "${query}" tidak ditemukan.`);
      return;
    }

    await sendWA(from, 
      `📦 *${found.nama}*\n` +
      `Stok saat ini: ${found.stokAkhir} ${found.satuanBeli}\n` +
      `Stok minimum: ${found.stokMinimum} ${found.satuanBeli}\n` +
      `Status: ${found.stokAkhir <= found.stokMinimum ? "⚠️ Di bawah minimum!" : "✅ Aman"}`
    );
    return;
  }

  // ── INPUT BARANG MASUK ───────────────────────────────
  if (firstLine.startsWith("masuk")) {
    const { tanggal, items } = parseInputBarang(lines);
    
    if (!tanggal) {
      await sendWA(from, "❌ Format tanggal tidak dikenali.\nContoh: *masuk 10/5*");
      return;
    }

    if (items.length === 0) {
      await sendWA(from, "❌ Tidak ada barang yang bisa diparse.\nContoh:\nmasuk 10/5\nayam tender 2\nminyak 6");
      return;
    }

    // Ambil daftar barang untuk matching
    const dataBarang = await getFromGAS({ action: "getBarang" });
    if (!dataBarang.ok || !Array.isArray(dataBarang.data)) {
      await sendWA(from, "❌ Gagal ambil daftar barang.");
      return;
    }

    // Proses setiap item
    const berhasil = [];
    const gagal = [];
    const tidakDitemukan = [];

    for (const item of items) {
      const found = cariBarang(item.nama, dataBarang.data);
      if (!found) {
        tidakDitemukan.push(item.nama);
        continue;
      }

      try {
        const result = await postToGAS({
          action: "addTransaksi",
          itemId: found.id,
          jumlah: item.jumlah,
          tanggal,
          catatan: "via WA Bot"
        });

        if (result.ok) {
          berhasil.push(`✅ ${found.nama}: ${item.jumlah} ${found.satuanBeli}`);
        } else {
          gagal.push(`❌ ${found.nama}: ${result.error || "gagal"}`);
        }
      } catch (e) {
        gagal.push(`❌ ${found.nama}: error`);
      }

      // Delay kecil antar request
      await new Promise(r => setTimeout(r, 300));
    }

    // Buat response
    const tglFormatted = tanggal.split("-").reverse().join("/");
    let msg = `📋 *Input Barang Masuk ${tglFormatted}*\n\n`;
    
    if (berhasil.length) msg += berhasil.join("\n") + "\n";
    if (gagal.length) msg += "\n" + gagal.join("\n") + "\n";
    if (tidakDitemukan.length) {
      msg += `\n⚠️ *Tidak ditemukan:*\n` + tidakDitemukan.map(n => `• ${n}`).join("\n");
      msg += "\n\nKetik *daftar barang* untuk lihat semua nama barang.";
    }

    msg += `\n\n📊 ${berhasil.length}/${items.length} berhasil disimpan.`;
    await sendWA(from, msg);
    return;
  }

  // ── DAFTAR BARANG ────────────────────────────────────
  if (firstLine === "daftar barang" || firstLine === "daftar") {
    const data = await getFromGAS({ action: "getBarang" });
    if (!data.ok || !Array.isArray(data.data)) {
      await sendWA(from, "❌ Gagal ambil daftar barang.");
      return;
    }

    const list = data.data.map(b => `• ${b.nama} (${b.satuanBeli})`).join("\n");
    await sendWA(from, `📦 *Daftar Barang:*\n\n${list}`);
    return;
  }

  // ── BANTUAN ──────────────────────────────────────────
  await sendWA(from,
    `🤖 *AyamTenns Stock Bot*\n\n` +
    `*Perintah yang tersedia:*\n\n` +
    `📥 *Input barang masuk:*\n` +
    `masuk 10/5\nayam tender 2\nminyak 6\ntepung 3\n\n` +
    `📦 *Cek stok:*\n` +
    `stok ayam tender\n\n` +
    `⚠️ *Cek stok rendah:*\n` +
    `stok\n\n` +
    `📋 *Daftar semua barang:*\n` +
    `daftar barang`
  );
}

// ── Vercel serverless handler ───────────────────────────────────
export default async function handler(req, res) {
  // Webhook verification (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("Webhook verified!");
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Forbidden");
  }

  // Terima pesan (POST)
  if (req.method === "POST") {
    try {
      const body = req.body;
      
      if (body.object === "whatsapp_business_account") {
        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;
        const messages = value?.messages;

        if (messages && messages.length > 0) {
          const msg = messages[0];
          const from = msg.from;
          const text = msg.type === "text" ? msg.text.body : null;

          if (text) {
            await handleMessage(from, text).catch(console.error);
          }
        }
      }

      return res.status(200).json({ status: "ok" });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ status: "ok" }); // Always return 200 to Meta
    }
  }

  return res.status(405).send("Method not allowed");
}
