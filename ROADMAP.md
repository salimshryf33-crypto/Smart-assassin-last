# Sage — خارطة الإصلاحات والمهام

> مرتبة حسب الأولوية. آخر تحديث: يونيو 2026.
> مصدر: تقرير Production Readiness Audit الكامل.

---

## ✅ مكتمل — تم التطبيق

| # | الإصلاح | الملف |
|---|---|---|
| ✅ 1 | امتحانات الأدمن أصبحت public تلقائياً | `curriculum.ts` السطر 118 |
| ✅ 2 | CORS مرن عبر `ALLOWED_ORIGINS` (مفتوح في dev، مقيّد في prod عبر env var) | `app.ts` |
| ✅ 3 | Security headers مكتملة — أضيف CSP + HSTS | `securityHeaders.ts` |
| ✅ 4 | `/api/health` تعمل بجانب `/api/healthz` | `health.ts` |
| ✅ 5 | Audit Log يُكتب فعلياً — عند الرفع، الحذف، بداية الامتحان، إتمامه | `curriculum.ts` + `examSolver.ts` |
| ✅ 6 | جدول `flashcards` في DB — البطاقات تُحفظ بشكل دائم | `dbMigrations.ts` |
| ✅ 7 | السجل الوهمي `fb270347` حُذف تلقائياً عند الإقلاع | `dbMigrations.ts` |
| ✅ 8 | `doc_type = null` أُصلح تلقائياً عند الإقلاع | `dbMigrations.ts` |
| ✅ 9 | عمود `weak_topics_json` أُضيف لـ `weakness_snapshots` | `dbMigrations.ts` |

---

## 🔴 لم يُحل بعد — يمنع الإطلاق

| # | المشكلة | الخطوة المطلوبة |
|---|---|---|
| 1 | **Object Storage غير متصل** — `REPLIT_OBJECT_STORAGE_BUCKET_ID` غير مضبوط | اضبط المتغير في Replit Secrets |
| 2 | **كتاب الفيزياء: 11.6% فقط مستخرج** — 25 من 215 صفحة، وضعه `done` خطأ | غيّر status إلى `partial` من لوحة الأدمن لتشغيل Resume Scheduler |
| 3 | **حصة Gemini المجانية: 20 طلب/يوم** | فعّل الحصة المدفوعة عند الإطلاق (مخطط مسبقاً ✅) |

---

## 🟠 لم يُحل بعد — يجب قبل الإطلاق

| # | المشكلة | الخطوة المطلوبة |
|---|---|---|
| 4 | **Redis غير مضبوط** — الكاش يُفقد عند كل إعادة تشغيل | اضبط `REDIS_URL` في Replit Secrets |
| 5 | **الفلاش كارد لا تُحفظ من الـ endpoint للـ DB** — الجدول موجود لكن `examSolver.ts` لا يكتب فيه | وصّل endpoint الفلاش كارد بجدول `flashcards` |
| 6 | **`49285e0a` مُصنّف كـ book غلط** — هو امتحان أحياء 2022 مكرر | احذفه من لوحة الأدمن |

---

## 🟡 تحسينات مستقبلية — بعد الإطلاق

| # | التحسين |
|---|---|
| 7 | صفحة للطالب يتصفح فيها الامتحانات المتاحة حسب المادة والصف |
| 8 | إحصائيات استخدام في لوحة الأدمن (كم طالب حل كل امتحان) |
| 9 | FK constraint: `exam_records.curriculum_doc_id → curriculum_documents.id` (دائم، ليس فقط عند الإقلاع) |
| 10 | قاعدة بيانات قراءة فقط (Read Replica) عند 1000+ طالب |
| 11 | RBAC — تعيين دور admin للمستخدمين من لوحة الأدمن |

---

## ✅ يعمل بشكل صحيح — لا تعديل مطلوب

- OCR Pipeline كامل (رفع → استخراج → تقطيع → تضمين → RAG → دردشة)
- استخراج الأسئلة + إزالة التكرار
- حل الامتحان + التصحيح التلقائي + تحليل الضعف
- Resume Scheduler (يكمل OCR المتوقف)
- Rate Limiting (Token Bucket مدعوم بـ PostgreSQL)
- PDF Validation (Magic Bytes + SHA-256 dedup)
- Firebase Authentication
- Admin Dashboard
- سلسلة الاسترداد عند الإقلاع (Startup Recovery Chain)

---

## 📊 نتيجة التدقيق — قبل وبعد الإصلاحات

| المحور | قبل | بعد |
|---|---|---|
| Security | 60/100 | 78/100 |
| Reliability | 58/100 | 65/100 |
| Architecture | 74/100 | 74/100 |
| Scalability | 32/100 | 32/100 |
| **جاهزية الإنتاج** | **54/100** | **67/100** |

---

## 🚀 عند الانتقال لنطاقك الخاص

```
ALLOWED_ORIGINS=https://yourdomain.com   ← اضبط في Replit Secrets أو .env
REDIS_URL=redis://...                    ← اضبط عند تفعيل Redis
REPLIT_OBJECT_STORAGE_BUCKET_ID=...     ← اضبط لتفعيل Object Storage
```
