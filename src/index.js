// src/index.js
import "dotenv/config";
import fs from "fs";
import path from "path";
import cron from "node-cron";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import tz from "dayjs/plugin/timezone.js";
import qrcode from "qrcode-terminal";
import pkg from "whatsapp-web.js";
import os from "os";
import express from "express";

const { Client, LocalAuth } = pkg;

dayjs.extend(utc);
dayjs.extend(tz);

// ----------------- CONFIG -----------------
const COUNTRY_CODE = (process.env.COUNTRY_CODE || "20").replace(/\D+/g, "");
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "").replace(/\D+/g, "");
const TZ = process.env.TZ || "Africa/Cairo";
const DAILY_CRON = process.env.DAILY_CRON || "0 9 * * *";
const SEND_TO_BIRTHDAY_PERSONS =
  String(process.env.SEND_TO_BIRTHDAY_PERSONS || "true").toLowerCase() ===
  "true";
const FEB29_HANDLING = (process.env.FEB29_HANDLING || "feb28").toLowerCase();
const GROUP_NAME = process.env.GROUP_NAME || "جروب";
const MAX_RETRIES = 3;

const __dirname = path
  .dirname(new URL(import.meta.url).pathname)
  .replace(/^\/([A-Za-z]):/, "$1:");
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let targetGroupId = null;

// ----------------- CLIENT -----------------
const isWindows = os.platform() === "win32";

const client = new Client({
  authStrategy: new LocalAuth({ clientId: "birthday-bot" }),
  puppeteer: isWindows
    ? { headless: false } // محلي: Chrome يفتح
    : {
        headless: true, // سيرفر: headless
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--single-process",
          "--disable-gpu",
        ],
      },
});

client.on("qr", (qr) => {
  console.log("📱 امسح الكود ده بالواتساب:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", async () => {
  console.log("✅ WhatsApp client جاهز!");

  try {
    const chats = await client.getChats();
    const group = chats.find((c) => c.isGroup && c.name === GROUP_NAME);
    if (group) {
      targetGroupId = group.id._serialized;
      console.log(`➡️ الجروب موجود: ${GROUP_NAME}`);
      await safeSendMessage(targetGroupId, "✅ رسالة تجريبية من البوت");
    } else {
      console.warn(`❌ الجروب "${GROUP_NAME}" مش موجود.`);
    }
  } catch (e) {
    console.error("❌ مشكلة في جلب الجروبات:", e.message);
  }

  if (OWNER_NUMBER) {
    await safeSendMessage(
      toWhatsAppId(OWNER_NUMBER),
      "✅ رسالة تجريبية للمالك"
    );
  }

  await runDailyJob();
});

// ----------------- HELPERS -----------------
function toWhatsAppId(number) {
  number = number.replace(/\D+/g, "");
  if (!number.startsWith(COUNTRY_CODE)) number = COUNTRY_CODE + number;
  return number + "@c.us";
}

function normalizeBirthday(birthday) {
  if (!birthday) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    const d = dayjs(birthday);
    return { month: d.month() + 1, day: d.date() };
  }
  const parts = birthday.replace(/\//g, "-").split("-");
  if (parts.length === 2) {
    const [a, b] = parts.map(Number);
    if (a > 12 && b <= 12) return { month: b, day: a };
    return { month: a, day: b };
  }
  return null;
}

function isBirthdayToday(birthday, month, day, feb29Handling) {
  const b = normalizeBirthday(birthday);
  if (!b) return false;
  if (b.month === 2 && b.day === 29 && feb29Handling === "feb28") {
    return (month === 2 && day === 28) || (month === 2 && day === 29);
  }
  return b.month === month && b.day === day;
}

function loadBirthdays(dataDir, countryCode) {
  const filePath = path.join(dataDir, "birthdays.json");
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  const list = JSON.parse(raw);
  return list.map((p) => {
    if (p.number && !p.number.startsWith(countryCode))
      p.number = countryCode + p.number.replace(/\D+/g, "");
    return p;
  });
}

function buildMessage(todayStr, todaysList) {
  if (!todaysList.length) return null;
  const lines = [`🎉 تذكير أعياد ميلاد اليوم (${todayStr})`];
  todaysList.forEach((p, idx) => {
    lines.push(`${idx + 1}. ${p.name}${p.number ? " — +" + p.number : ""}`);
  });
  lines.push("— وُرِدَ بواسطة بوت التذكير 🎂");
  return lines.join("\n");
}

async function safeSendMessage(chatId, text, retries = 0) {
  try {
    await client.sendMessage(chatId, text);
    console.log(`✅ الرسالة اتبعت لـ ${chatId}`);
    return true;
  } catch (e) {
    if (retries < MAX_RETRIES) {
      console.warn(`⚠️ إعادة المحاولة ${retries + 1} لـ ${chatId}`);
      await new Promise((r) => setTimeout(r, 2000));
      return safeSendMessage(chatId, text, retries + 1);
    } else {
      console.error("❌ فشل الإرسال بعد عدة محاولات لـ", chatId, e.message);
      return false;
    }
  }
}

// ----------------- JOB -----------------
async function runDailyJob() {
  const now = dayjs().tz(TZ);
  const month = now.month() + 1;
  const day = now.date();
  const todayStr = now.format("YYYY-MM-DD");

  const people = loadBirthdays(DATA_DIR, COUNTRY_CODE);
  const todays = people.filter((p) =>
    isBirthdayToday(p.birthday, month, day, FEB29_HANDLING)
  );

  const msg = buildMessage(todayStr, todays);

  if (!msg) {
    console.log("📭 النهارده مفيش أي أعياد ميلاد.");
    return;
  }

  console.log("📨 الرسالة النهائية اللي هتبعت:\n" + msg);

  if (OWNER_NUMBER) await safeSendMessage(toWhatsAppId(OWNER_NUMBER), msg);
  if (targetGroupId) await safeSendMessage(targetGroupId, msg);

  if (SEND_TO_BIRTHDAY_PERSONS) {
    for (const p of todays) {
      if (!p.number) continue;
      const text = `🎂 كل سنة وانت طيب/طيبة يا ${p.name}! 🥳\n\nنتمنى لك يوم سعيد مليان فرحة.`;
      await safeSendMessage(toWhatsAppId(p.number), text);
    }
  }
}

// ----------------- CRON -----------------
cron.schedule(
  DAILY_CRON,
  () => runDailyJob().catch((err) => console.error("Daily job error:", err)),
  { timezone: TZ }
);

console.log(`🗓️ تم جدولة التذكير: "${DAILY_CRON}" على التايم زون ${TZ}`);

// ----------------- EXPRESS (Dashboard) -----------------
const app = express();
app.get("/", (req, res) => {
  res.send("<h1>✅ WhatsApp Birthday Bot شغال!</h1>");
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌍 افتحي http://localhost:${PORT} في المتصفح`);
});

client.initialize();
