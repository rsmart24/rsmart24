# RS Mart — Cloudflare Worker storefront

RS Mart-এর অনলাইন স্টোরফ্রন্ট। ক্রেতারা ওয়েবসাইটে পণ্য দেখবেন এবং অর্ডার করবেন। সব অর্ডার প্রথমে Cloudflare D1-এ সংরক্ষিত হয়। Admin Panel থেকে প্রয়োজন অনুযায়ী ম্যানুয়ালি Business Koro-তে পাঠানো যায়; স্বয়ংক্রিয়ভাবে পাঠানো হয় না।

## কী কী আছে
- বাংলা-সমর্থিত responsive storefront (মোবাইল ও কম্পিউটার)
- Business Koro Storefront API থেকে পণ্যের তালিকা, ভ্যারিয়েন্ট, স্টক ও ডেলিভারি চার্জ পড়া
- Admin Panel থেকে পণ্যের বিক্রয়মূল্য, ছাড় ও দৃশ্যমানতা নিয়ন্ত্রণ
- এক বা একাধিক পণ্যের অর্ডার, COD এবং অগ্রিম ডেলিভারি চার্জ পেমেন্টের তথ্য
- Cloudflare D1-এ অর্ডার সংরক্ষণ এবং Admin Panel-এ অর্ডার দেখা/স্ট্যাটাস আপডেট
- API key ও Admin password শুধু Cloudflare Worker secrets-এ রাখা হয়; ব্রাউজারে প্রকাশ করা হয় না

## Cloudflare সেটআপ
Worker-এ নিচের binding ও secrets থাকতে হবে:

### D1 database binding
- Binding name: `DB`
- Database: `rsmart24-db`

### Worker secrets
- `BUSINESS_KORO_API_KEY` — পণ্যের তথ্য পড়া এবং Admin Panel থেকে ম্যানুয়ালি অর্ডার পাঠানোর জন্য
- `ADMIN_PASSWORD` — RS Mart Admin Panel-এ লগইনের জন্য
- `TELEGRAM_BOT_TOKEN` এবং `TELEGRAM_GROUP_ID` — নতুন অর্ডারের Telegram notification ও Test Message-এর জন্য
- `STEADFAST_API_KEY` এবং `STEADFAST_SECRET_KEY` — Steadfast-এর tracking status API ব্যবহার করলে

ঐচ্ছিক variable:
- `BUSINESS_KORO_DOMAIN` — Business Koro API-তে এই স্টোরের domain header প্রয়োজন হলে

**গুরুত্বপূর্ণ:** Business Koro API key পণ্য/স্টক/ডেলিভারি চার্জ পড়া এবং Admin Panel থেকে ম্যানুয়ালি অর্ডার পাঠানোর জন্য ব্যবহৃত হয়। কোনো অর্ডার স্বয়ংক্রিয়ভাবে Business Koro-তে পাঠানো হয় না।

## অর্ডার সংরক্ষণের নিয়ম
1. ক্রেতা ওয়েবসাইটে অর্ডার সাবমিট করেন।
2. Worker সার্ভার-সাইডে পণ্য, স্টক, ভ্যারিয়েন্ট, মূল্য ও অর্ডারের তথ্য যাচাই করে।
3. বৈধ অর্ডার Cloudflare D1-এর `orders` টেবিলে সংরক্ষিত হয়।
4. Admin Panel `/api/admin/orders` থেকে D1-এর অর্ডার দেখায়।
5. অগ্রিম পেমেন্টের Transaction ID Admin Panel-এ ম্যানুয়ালি যাচাই করতে হবে।
6. অর্ডারটি Business Koro-তে পাঠাতে হলে Admin Panel-এর অর্ডার বিস্তারিত খুলে ডেলিভারি চার্জের নিয়ম নির্বাচন করে **Business Koro-তে পাঠান** চাপতে হবে। এটি সম্পূর্ণ ম্যানুয়াল; অর্ডার জমা হলেই Business Koro-তে যায় না।
7. Business Koro API একবারে একটি পণ্য এবং quantity 1 গ্রহণের সীমাবদ্ধতায় থাকলে অন্য অর্ডারগুলো Admin Panel-এ থাকবে; ভুল তথ্য পাঠানোর বদলে Worker সেগুলো প্রত্যাখ্যান করবে।

Business Koro-তে অর্ডার পাঠানোর নিয়ম:

ক্রেতাদের জন্য মোবাইল নম্বর ও জেলা দিয়ে অর্ডার খোঁজার পেজ/API ইচ্ছাকৃতভাবে সরানো হয়েছে। অর্ডার ব্যবস্থাপনা Admin Panel-এ সীমাবদ্ধ।

## Local development
```bash
npm install
npm run dev
```

## Deploy
```bash
npx wrangler deploy
```

Deploy করার পর Cloudflare Dashboard-এ সর্বশেষ deployment-এর status `Ready` এবং traffic 100% হয়েছে কি না যাচাই করুন।

## গুরুত্বপূর্ণ পরীক্ষা
লাইভে প্রচারের আগে একটি test order দিয়ে নিশ্চিত করুন:
- অর্ডার সফলভাবে জমা হয়
- Admin Panel-এ অর্ডার দেখা যায়
- পণ্য/স্টক/ভ্যারিয়েন্ট যাচাই কাজ করে
- COD ও অগ্রিম পেমেন্টের হিসাব সঠিক থাকে
- মোবাইল ও কম্পিউটার—দুই জায়গাতেই checkout ব্যবহারযোগ্য থাকে
