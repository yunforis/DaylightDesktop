# 发票助手实收测试材料

生成日期：2026-10-16（北京时间）。本目录包含 **5 份 PDF、4 份 PNG、1 份 JPG**，每份附件对应一张不同的虚构发票。票面均注明测试用途，不可报销。组织、税号和交易均为虚构。

## 附件与核对场景

| 编号 | 附件 | 核对场景 | 价税合计 |
| --- | --- | --- | ---: |
| 01 | [办公用品](01_office-supplies.pdf) | PDF 文字层、两条明细、13%、前导零票号 | CNY 350.30 |
| 02 | [软件服务](02_software-service.pdf) | PDF 文字层、发票代码、6% 服务费 | CNY 1,272.00 |
| 03 | [酒店住宿](03_hotel-accommodation.pdf) | PDF 文字层、增值税专用发票、两晚住宿 | CNY 890.40 |
| 04 | [免税图书](04_tax-exempt-books.pdf) | PDF 文字层、免税、税额 0.00 | CNY 264.00 |
| 05 | [个人培训](05_personal-training.pdf) | PDF 文字层、个人购买方、缺失购买方税号 | CNY 636.00 |
| 06 | [电脑配件](06_computer-accessories.png) | PNG OCR、键盘和鼠标两条明细 | CNY 628.28 |
| 07 | [客运服务](07_passenger-transport.png) | PNG OCR、发票代码、9% 税率 | CNY 392.40 |
| 08 | [餐饮服务](08_catering.png) | PNG OCR、三条餐饮明细、6% | CNY 203.52 |
| 09 | [设计服务](09_missing-tax-total.jpg) | JPG OCR、未提供税额合计，不得按金额相减补齐 | CNY 318.00 |
| 10 | [英文商业发票](10_usd-commercial.png) | PNG OCR、USD、未提供代码和购销方税号 | USD 99.00 |

人工核对基准在 [expected-results.json](expected-results.json)，含票号、日期、购销方、税号、金额、明细和原件 SHA-256。它只供核对，**没有作为预置提取结果导入，也没有作为模型回复或邮件附件发送**。每张票据的票面数据才是模型提取依据。

全部价税合计按币种分别为 **CNY 4,954.90**、**USD 99.00**，不可合并成一个跨币种总额。缺失字段应为 `null`，而不是根据其他字段推算。

## 真实邮件批次

- 收件人：`3462740458@qq.com`。
- 批次：`20261016-be9e6670`。
- 每封邮件附一个对应原件，共 10 封；主题形如 `Daylight invoice test 20261016-be9e6670 01/10 [PDF]`。
- 邮件正文仅说明测试用途，没有提供票号、金额或明细答案。
- [send-results.json](send-results.json) 记录 SMTP 接受及 QQ 收件箱确认；[verification-results.json](verification-results.json) 记录真实收信、附件字节核对和助手字段比较结果。
- QQ 会改写投递后的 Message-ID，使用唯一主题、收件人及附件哈希关联发送和收件记录。

## 在页面核对

1. 登录运行中的 Daylight，选择 `3462740458@qq.com`，打开 [发票助手](http://127.0.0.1:3000/app/invoices)。
2. 搜索批次 `20261016-be9e6670`，应找到 10 张票据，并分别展示 CNY、USD 金额合计。
3. 对照原件与人工基准检查各字段及明细，特别检查缺失税号、缺失税额合计和前导零。
4. 从票据打开原邮件，确认主题、附件名称与原件预览/下载。
5. 查看 [VERIFICATION.md](VERIFICATION.md) 了解本次实际通过项及识别缺陷。`extracted` 表示产生了票据结果，不表示每个字段都正确。

成功邮件再次同步会去重；如需再次调用模型，请在该邮件/票据上显式「重新提取」。不要为了复验清空现有邮箱、日程或待办，也不要重复执行发送脚本。

生成脚本为 `work/create-invoice-test.py`；实发与投递验证脚本为 `work/send-invoice-test.mjs`。脚本不含真实凭据，发送时在内存读取现有配置。临时预览图和核对过程位于 `work/invoice-mail-live/`。
