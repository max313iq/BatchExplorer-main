# TODO — تنفيذ إنشاء أحواض Zero-Node عبر جميع الريجونات مع الزيادة التدريجية ومراقبة Idle

> المصدر: التقرير التحليلي الموجود في الملف `تقرير تحليلي لتعديل تطبيق BatchExplorer لتنفيذ إنشاء أحواض صفر نود عبر جميع الريجونات مع زيادة تدريج.docx`.

## 1) حسم المتطلبات غير المحددة (Decision Log)

> **قرارات تنفيذية معتمدة (v1):** الهدف تحويل القسم من "نقاط مفتوحة" إلى إعداد baseline جاهز للتنفيذ ويمكن تعديله لاحقاً بإصدار v2.

- [x] تحديد المقصود من "جميع الريجونات":
  - [x] **اعتماد الخيار A**: التنفيذ على جميع `Batch Accounts` الموجودة فقط.
  - [x] **استبعاد الخيار B حالياً**: عدم إنشاء `Batch Accounts` جديدة تلقائياً (خارج النطاق في v1).
- [x] اعتماد Naming convention للـPool التجريبي:
  - [x] الصيغة المعتمدة: `bootstrap-{location}-{yyyyMMdd-HHmm}-{rand4}`
  - [x] مثال: `bootstrap-eastus-20261020-1435-a9f3`
- [x] تحديد نوع النود المستهدف:
  - [x] الافتراضي: `targetDedicatedNodes` فقط في v1.
  - [x] خيار اختياري لاحق: `targetLowPriorityNodes` عبر إعداد متقدم (v2).
- [x] تحديد قالب إعداد الـPool (افتراضي v1):
  - [x] VM image: Ubuntu LTS مدعوم من Batch account.
  - [x] VM size: `Standard_D2s_v3` (قابل للتغيير عبر config).
  - [x] Network: نفس إعداد الشبكة الافتراضي للحساب (بدون VNET مخصص في v1).
  - [x] Start task: أمر خفيف للتحقق من الجاهزية فقط.
  - [x] Node agent SKU: يحدد تلقائياً بما يتوافق مع image المختارة.
- [x] تحديد Maximum target per account:
  - [x] `maxTargetPerAccount = 20` كـ hard-cap حماية في v1.
  - [x] الإيقاف أيضاً عند أول quota/resize failure مع حفظ آخر target ناجح.
- [x] تحديد سياسة التزامن عبر الحسابات:
  - [x] baseline: `sequential` (concurrency = 1) في v1.
  - [x] تحسين لاحق: `bounded parallel` بقيمة افتراضية 2 في v2 بعد إثبات الاستقرار.
- [x] تحديد Timeout thresholds:
  - [x] provisioning timeout: 20 دقيقة لكل target.
  - [x] wait-for-idle timeout: 10 دقائق.
  - [x] retry window: 5 محاولات مع exponential backoff (2s, 4s, 8s, 16s, 32s).
- [x] تحديد سياسة التعامل مع `running` nodes:
  - [x] لا حذف فوري.
  - [x] انتظار 3 دورات polling متتالية.
  - [x] إذا استمرت `running` بعد المهلة → تسجيل الحالة كـ "requires-manual-review" وتخطي الحذف.
- [x] تحديد سلوك ما بعد الانتهاء (cleanup):
  - [x] الافتراضي: الإبقاء على الـPools للتحقق.
  - [x] خيار تشغيلي: `cleanupAfterRun=true` لحذف الـPools التجريبية تلقائياً.
- [x] تحديد تفعيل الميزة:
  - [x] التفعيل عبر Feature Flag باسم: `features.multiRegionPoolBootstrap`.
  - [x] القيمة الافتراضية في الإنتاج: `false` حتى انتهاء rollout المرحلي.

### 1.1) Baseline Config Snapshot (v1)
```yaml
features:
  multiRegionPoolBootstrap: false

scope:
  includeExistingBatchAccountsOnly: true
  autoCreateBatchAccountsPerRegion: false

pool:
  idPattern: "bootstrap-{location}-{yyyyMMdd-HHmm}-{rand4}"
  nodeType: dedicated
  vmSize: Standard_D2s_v3
  image: UbuntuLTS
  maxTargetPerAccount: 20

execution:
  concurrency: 1
  provisioningTimeoutMinutes: 20
  waitForIdleTimeoutMinutes: 10
  retryAttempts: 5
  retryBackoffSeconds: [2, 4, 8, 16, 32]

policy:
  runningNodeAction: manual-review-after-3-polls
  cleanupAfterRun: false
```

### 1.2) Change Control (v2 لاحقاً)
- [ ] أي تعديل على قيم baseline أعلاه يجب أن يوثَّق كـ `Decision Log v2` داخل نفس الملف مع:
  - [ ] سبب التعديل (Cost/Performance/Reliability).
  - [ ] تاريخ التعديل والبيئة المستهدفة (Dev/Test/Prod).
  - [ ] أثر التعديل على التكلفة والزمن ومعدل الفشل.

## 2) واجهة المستخدم (زر واحد للتشغيل)
- [ ] إضافة زر جديد في `desktop/src/app/components/pool/home/pool-home.html` لتشغيل العملية متعددة الريجونات.
- [ ] إضافة action handler في `pool-home.component.ts` باسم واضح (مثال: `bootstrapAllRegions`).
- [ ] حقن خدمة orchestration داخل `PoolHomeComponent` واستدعاء `run()`.
- [ ] إضافة Tooltip/Label واضح أن العملية قد تنشئ موارد قابلة للفوترة.
- [ ] إضافة تأكيد قبل التشغيل (modal/confirm) يوضح التكلفة والمدة المتوقعة.
- [ ] تعطيل الزر أثناء التشغيل لتفادي بدء عمليات متوازية غير مقصودة.

## 3) خدمة Orchestrator جديدة
- [ ] إنشاء خدمة جديدة (مقترح):
  - [ ] `desktop/src/app/services/pool-bootstrap/multi-region-pool-bootstrap.service.ts`
- [ ] تعريف عقدة تشغيل واضحة (state machine):
  - [ ] Discover accounts
  - [ ] Ensure pool @0
  - [ ] Resize target +1
  - [ ] Wait steady + nodes ready
  - [ ] Verify all idle
  - [ ] Remediate non-idle
  - [ ] Repeat until quota/failure
- [ ] بناء Summary نهائي لكل Account/Region:
  - [ ] last successful target
  - [ ] reason for stop
  - [ ] elapsed time
  - [ ] retry counts / errors

## 4) اكتشاف الحسابات والريجونات
- [ ] استخدام `ArmBatchAccountService.load/list` لجلب كل الحسابات عبر subscriptions.
- [ ] ربط كل Account بالـ`location` والـ`accountEndpoint`.
- [ ] (اختياري) استخدام `ArmLocationService` + `ArmProviderService` لحصر المواقع المدعومة وإظهار skipped locations بدون حساب.
- [ ] اعتماد سياسة اختيار الحسابات عند التكرار/الازدواج (dedupe by account id).

## 5) تمكين Data Plane على حساب محدد (ليس currentAccount فقط)
- [ ] تعديل `desktop/src/app/services/azure-batch/core/batch-http.service.ts` لإضافة `requestForAccount(account, method, uri, options)`.
- [ ] إعادة استخدام نفس منطق المصادقة الحالي:
  - [ ] AAD token لحسابات ARM
  - [ ] SharedKey للحسابات المحلية
- [ ] ضمان أن URL يبنى من endpoint الخاص بالحساب الممرر.
- [ ] إبقاء `request()` الحالية دون كسر backward compatibility.

## 6) تنفيذ عمليات Pool/Node داخل الـOrchestrator
- [ ] Ensure pool exists:
  - [ ] GET pool
  - [ ] إذا 404 → POST pool بإعداد target = 0
- [ ] Resize تدريجي:
  - [ ] POST `/pools/{poolId}/resize` من 0 → 1 → 2 ...
  - [ ] الالتزام بشرط `allocationState=steady` قبل كل resize/removenodes.
- [ ] Polling loop:
  - [ ] GET pool للحالة والأعداد
  - [ ] GET nodes للحالات
  - [ ] إكمال المرحلة عند: steady + node count = target + كل nodes = idle
- [ ] Remediation:
  - [ ] جمع non-idle nodes
  - [ ] حذف على دفعات max=100 node ids لكل request
  - [ ] انتظار replacement nodes حتى idle

## 7) قواعد التعامل مع حالات النود (Policy Matrix)
- [ ] `idle` → لا إجراء.
- [ ] `creating/starting/waitingForStartTask` → انتظار حتى timeout قبل الحذف (لتقليل thrashing).
- [ ] `startTaskFailed/unusable` → حذف فوري غالباً.
- [ ] `running` → تطبيق السياسة المعتمدة (من قسم القرارات) لتجنب قتل workload غير مقصود.
- [ ] توثيق السياسة في الكود + الرسائل المعروضة للمستخدم.

## 8) التزامن، الثبات، وإدارة الأخطاء
- [ ] تنفيذ mutex لكل Pool لمنع تداخل resize/removenodes.
- [ ] إضافة retry مع exponential backoff عند 409/429 والأخطاء العابرة.
- [ ] دعم bounded concurrency عبر الحسابات (configurable).
- [ ] إيقاف آمن عند quota errors مع حفظ آخر target ناجح.
- [ ] عدم إسقاط العملية بالكامل بسبب فشل حساب واحد (continue with next account).

## 9) Activity Monitor والـTelemetry
- [ ] تسجيل مراحل التنفيذ في `ActivityService` لكل Account/Pool/Target.
- [ ] عرض progress حيّ (current region, target, wait status, remediation count).
- [ ] عرض actionable errors (quota exceeded, allocation not steady, auth issues).
- [ ] إضافة زر Cancel إن كانت البنية تدعم ذلك.

## 10) حدود الـQuota والتكلفة
- [ ] عند فشل resize بسبب quota: اعتماد آخر target ناجح كـcapacity limit عملي.
- [ ] تسجيل نوع الفشل (cores quota / pool quota / regional capacity / spot shortage).
- [ ] إظهار تحذير واضح قبل التشغيل عن التكلفة المحتملة.
- [ ] (اختياري) إضافة خيار `cleanup after run` لحذف pools التجريبية.

## 11) الاختبارات
### Unit Tests
- [ ] اختبار دوال `isNodeHealthy/shouldRemoveNode` عبر جميع states.
- [ ] اختبار retry/backoff logic عند 409/429.
- [ ] اختبار chunking لحذف النود (100 لكل request).
- [ ] اختبار state machine transitions (success/fail/cancel paths).

### Integration (ريجون واحد)
- [ ] سيناريو: ensure pool @0 → resize 1 → wait idle.
- [ ] سيناريو non-idle injection ثم removenodes ثم replacement idle.
- [ ] سيناريو quota failure والتحقق من stop reason.

### Staged Multi-Region Rollout
- [ ] التشغيل أولاً بتزامن = 1.
- [ ] زيادة التزامن تدريجياً مع مراقبة 429/errors/total duration.
- [ ] مقارنة النتائج بين regions (targets reached, failure reasons).

## 12) النشر والـRollback
- [ ] وضع الميزة خلف Feature Flag (أو gate بديل).
- [ ] خطة rollout مرحلية: internal → limited users → general.
- [ ] خطة rollback سريعة (تعطيل الزر أو revert commit).
- [ ] تحديث المستندات الداخلية (تشغيل، قيود، تكاليف، troubleshooting).

## 13) تعريف إنجاز (Definition of Done)
- [ ] زر التشغيل يعمل من صفحة Pools.
- [ ] التنفيذ يمر على جميع الحسابات المستهدفة بنجاح/فشل مع summary واضح.
- [ ] يتم إنشاء Pool عند 0 nodes ثم زيادة تدريجية حتى الحد العملي.
- [ ] أي non-idle nodes تُعالج تلقائياً وفق السياسة المعتمدة.
- [ ] Activity Monitor يعرض كل المراحل والأخطاء بشكل مفهوم.
- [ ] الاختبارات الأساسية (unit + integration المحددة) ناجحة.
- [ ] التوثيق الداخلي محدث ويشمل التحذيرات والتكلفة.

---

## ملحق — تسلسل تنفيذي مختصر (Checklist تشغيلية)
- [ ] Discover accounts
- [ ] For each account:
  - [ ] Ensure pool exists @0
  - [ ] target = 1
  - [ ] resize(target)
  - [ ] wait steady + count + idle
  - [ ] if non-idle → removenodes + wait replacements
  - [ ] target++
  - [ ] stop on quota/fatal error
  - [ ] record summary
- [ ] Present global summary
