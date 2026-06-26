# Sage — خارطة الإصلاحات والمهام

> مرتبة حسب الأولوية. آخر تحديث: يونيو 2026.
> مصدر: تقرير Production Readiness Audit الكامل.

---

## 🔴 أولوية قصوى — يمنع الإطلاق

| # | المشكلة | الملف المسؤول | التأثير |
|---|---|---|---|
| 1 | **الامتحانات المرفوعة من الأدمن كلها private** — الطلاب لا يرونها | `artifacts/api-server/src/routes/curriculum.ts` السطر 112 | الوظيفة الأساسية للمنصة معطلة |
| 2 | **Object Storage غير متصل** — `REPLIT_OBJECT_STORAGE_BUCKET_ID` غير مضبوط | Replit Secrets | الـ PDFs تضيع عند إعادة تشغيل الحاوية |
| 3 | **CORS مفتوح لكل الأوريجينز** — `app.use(cors())` بدون تقييد | `artifacts/api-server/src/app.ts` السطر 36 | أي موقع خارجي يستطيع استدعاء الـ API |
| 4 | **كتاب الفيزياء: 11.6% فقط مستخرج** — 25 من 215 صفحة | `index.json` → doc `aeab0878` | إجابات الذكاء الاصطناعي عن الفيزياء ناقصة 88% |
| 5 | **حصة Gemini المجانية: 20 طلب/يوم** | Gemini API key | تنتهي بـ 5-10 طلاب متزامنين | 

---

## 🟠 أولوية عالية — يجب قبل الإطلاق

| # | المشكلة | الملف المسؤول | التأثير |
|---|---|---|---|
| 6 | **Redis غير مضبوط** — الكاش يُحذف عند كل إعادة تشغيل | Replit Secrets → `REDIS_URL` | لا استمرارية للكاش |
| 7 | **الفلاش كارد لا تُحفظ في DB** — تختفي عند تحديث الصفحة | لا يوجد جدول `flashcards` في DB | تجربة مستخدم سيئة |
| 8 | **مسار health endpoint خاطئ** — `/api/healthz` لا `/api/health` | `artifacts/api-server/src/routes/health.ts` | أدوات المراقبة ترى 404 |
| 9 | **سجل `fb270347` الوهمي** — 74 سؤال بدون PDF أو curriculum doc | جدول `exam_records` في DB | يكسر التطبيق لو طالب حاول يحله |
| 10 | **CSP و HSTS headers مفقودة** | `artifacts/api-server/src/middleware/securityHeaders.ts` | أمان المتصفح ناقص |

---

## 🟡 أولوية متوسطة — بعد الإطلاق

| # | المشكلة | الملف المسؤول | التأثير |
|---|---|---|---|
| 11 | **Audit Log لا يُكتب أبداً** — جدول `audit_log` فارغ | لا يوجد `logAudit()` في أي route | لا تتبع لإجراءات الأدمن |
| 12 | **RBAC فارغ** — جدول `user_roles` فارغ، الكل student | DB → `user_roles` | لا توجد صلاحيات فعلية مضبوطة |
| 13 | **سجل النسخ الاحتياطية فارغ** — `db_backup_log` صفر صفوف | `backupScheduler.ts` | زر تحميل النسخة الاحتياطية لا يعمل |
| 14 | **`49285e0a` mistyped كـ book** — هو امتحان أحياء 2022 | `index.json` + `curriculum_documents` | يظهر للطلاب كمحتوى دراسي غلط |
| 15 | **`b1f370a7` بدون `doc_type`** — قيمة null في DB | جدول `curriculum_documents` | سلوك غير متوقع في الفلترة |

---

## 🟢 تحسينات مستقبلية — بعد استقرار الإطلاق

| # | التحسين |
|---|---|
| 16 | صفحة للطالب يتصفح فيها الامتحانات المتاحة حسب المادة والصف |
| 17 | إحصائيات استخدام في لوحة الأدمن (كم طالب حل كل امتحان) |
| 18 | FK constraint: `exam_records.curriculum_doc_id → curriculum_documents.id` |
| 19 | Foreign key: `exam_records.curriculum_doc_id → curriculum_documents.id` لمنع السجلات الوهمية |
| 20 | قاعدة بيانات قراءة فقط (Read Replica) عند 1000+ طالب |

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

## 📊 نتيجة التدقيق الأخيرة

| المحور | الدرجة |
|---|---|
| Architecture | 74/100 |
| Security | 60/100 |
| Reliability | 58/100 |
| Scalability | 32/100 |
| Data Durability | 65/100 |
| Performance | 63/100 |
| Maintainability | 78/100 |
| **جاهزية الإنتاج** | **54/100** |
