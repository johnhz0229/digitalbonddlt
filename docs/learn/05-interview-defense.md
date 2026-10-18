# 面试防守手册:面试官是 Peter Kohl-Landgraf

> 他是 ERC-7573 的作者、ERC-6123 的合著者、Smart Bond Contract 试点的负责人之一,在 DZ BANK Group Treasury。这个项目里的核心思想**都来自他**。所以他不会问"这是什么",他会问"你到底懂不懂"、"你哪里做错了"。

---

## 0. 一句话定位(先背熟)

> "I built small, simplified models of ideas from your published work, ERC-7573 and the Smart Bond Contract pilot, because I wanted to understand them by implementing them, not just by reading. I'm not claiming to improve on them."

**你的角色不是"发明者",而是"认真的学习者 + 能把需求变成规则和测试的人"。** 这正是 JD 要的 Werkstudent。

---

## 1. 必须诚实的边界(他一定能识破的地方)

| 问题 | 诚实的回答 |
|---|---|
| 代码是你写的吗? | **实话实说**:"I built it together with an AI coding assistant. I wrote the requirements and acceptance criteria, made the product decisions, reviewed every change, and I can walk you through any line." 然后**真的要能逐行讲**(见第 6 节)。被追问后才承认,会比主动说糟糕得多。 |
| 你读过哪些原文? | **试点报告(2026 年 3 月):读过全文。ERC-7573 EIP 页面:读过接口和流程。9 月的连接器论文:只读过摘要。** Innovation LAB 的博客,如果面试前读了原文就说读过,否则说"read summaries"。 |
| ERC-6123 | 本项目**没有实现** ERC-6123。模块 1 的 propose → confirm 和它的 `inceptTrade` / `confirmTrade` 是同一个思路(试点里交易确认也用了这对函数)。面试前请把 EIP-6123 的接口读一遍。 |
| 这是 ERC-7573 的实现吗? | **不是**。"A simplified model inspired by ERC-7573"。差别见第 4 节。 |

---

## 2. 红线:不要说的话

| ❌ 不要说 | ✅ 改成 |
|---|---|
| "I implemented ERC-7573." | "I built a simplified model following the idea of ERC-7573." |
| "DvP eliminates counterparty risk." | "DvP eliminates **principal** risk. Replacement-cost risk remains." |
| "The oracle is trustless." | "The oracle is **trust-minimised**: it holds a private key, but no trade state and no economic information." |
| "Stateless means it stores nothing." | "Stateless means it keeps no **trade** state. It still holds its decryption key, which is why threshold decryption matters." |
| "I read your September paper." | "I've only read the abstract; I tried to model the payment-versus-discharge idea from it." |
| "This is production-ready / bank-ready." | "It's a learning prototype: not audited, local ledgers, no legal finality." |
| "Blockchain removes the need for a CSD." | "In the pilot the crypto securities registrar (Cashlink) took over the register function under the eWpG; the legal role doesn't disappear." |

---

## 3. 他最可能问的问题和回答骨架

### A. 项目本身

**Q1. Walk me through your project.** → 现在优先用 **Smart Bond Lab**(`/lab`)和 `docs/learn/06-smart-bond-lab.md` 第 7 节的讲稿;第 5 节的讲稿作为补充,讲学习过程中的各个模块。

**Q2. Why did you build this?**
> "To understand the step from tokenisation to programmable instruments. Reading about DvP is easy; deciding what happens when the payment fails forced me to understand it."

**Q3. What was the hardest part / what did you get wrong?** ← **最好的答案就是那个漏洞**(Q12)。

### B. 结算基础

**Q4. What risk does DvP remove, and what remains?**
> 消除的是本金风险,也就是交了货却收不到钱。剩下的有:重置成本风险(对手在结算前违约,要按新价格重新成交)、流动性风险、操作风险,以及法律最终性的问题。

**Q5. Your cash token, what is it in reality?**
> "In the demo it's just an ERC-20. In reality it would be central bank money via the Trigger Solution or Pontes, or tokenised deposits. That changes the credit risk of the settlement asset, not the DvP logic."

**Q6. What does settlement finality mean on your ledger?**
> "Technically, a mined block on a local ledger. Legally, nothing; finality needs a designated system under the Settlement Finality Directive, or settlement in central bank money in T2, as in your pilot."

### C. 跨链 DvP(他的主场,问得最细)

**Q7. Why not an HTLC?**
> 卖方有自由期权(他决定是否、何时公开秘密,所以能观望市场);买方有错过时间窗口的风险;时间窗口难以设定:越长越安全,但越低效。

**Q8. Who generates the keys, and why does it matter?**
> "In my module 3, each party generates the key that benefits the other, so nobody holds the key that helps themselves. But the receiver can't verify that the hash and the ciphertext belong to the same plaintext. In your pilot the decryption oracle generates the key pair, which guarantees consistency. My module 4 uses that approach." ← 这个对比能证明你读过两份材料。

**Q9. What happens if the oracle is offline?**
> "Nothing is lost, but nothing moves. The bonds stay locked and the cash outcome is final, so the oracle is a **liveness** dependency, not a safety one. That's why replaceability matters; in the pilot NTT Data said the oracle could be replaced without redeploying contracts."

**Q10. What if the oracle is malicious?**
> "It could release the wrong key, for example the success key without payment. Threshold decryption spreads that trust across several parties. And keeping it stateless and blind to trade economics limits what it can learn and abuse."

**Q11. What does "stateless" buy you?**
> 运营更简单(没有数据库要备份、核对);审计更简单;可以替换;不知道交易内容,隐私更好,被攻击时能泄露的东西也更少。

**Q12. ⭐ "What stops the buyer from creating his own payment?"** ← 他很可能会问这个,因为这正是他自己设计时要解决的问题。
> "That was a real bug in my first version. Payments were identified only by transfer id, and the oracle only checked contract, id and outcome. So the buyer could pay one cent to his own second address under the same id, and the oracle released the success key. I reproduced it in a test. The fix binds the key to the payment terms: the key document names the payment contract, the payee and the amount, and the oracle checks them before decrypting. It stays stateless. Payments are now keyed by id and payee, so nobody can squat an id. **How does the reference implementation bind the key to the payment?**"
>
> **注意最后一句是真诚的提问。** 你没读过参考实现的代码,不要猜它是怎么做的。

**Q13. In your design the payment contract stores both ciphertexts. Is that a problem?**
> "Yes, for cost. Each is 384 bytes of storage. One could store only their hashes and pass the ciphertexts in calldata or events. I believe your 2024 blog mentioned storing only hashes for cost reasons." (只有在你读过那篇博客原文的情况下,才说最后一句。)

**Q14. How is your flow different from the pilot?**
> "In the pilot the investor first **locked cash** on the Trigger Solution against a hash; then the Smart Bond Contract moved the tokens and requested the key, which released the cash. In my model, the **bond** is locked and the payment chain executes the payment and decides the key. Both bind one outcome to one key, but in the pilot the cash commitment comes first. That's what makes principal risk structurally impossible."

### D. 付息与"付款对解除"

**Q15. What is payment versus discharge?**
> "The coupon claim on the bond is only discharged when the bond itself accepts the success preimage. A reported 'paid' status isn't enough. A failure preimage closes the attempt but not the claim."

**Q16. Why must failure not discharge the claim?**
> "Because then the failure path is harmless: at worst you retry. If failure could discharge, anyone able to trigger a failure could wipe out the investor's claim."

**Q17. What if the connector forwards the key twice?**
> "Nothing happens. Re-forwarding is idempotent, so after a timeout the connector simply sends again. That's an operational requirement as much as a technical one."

**Q18. How do you calculate the coupon?** ← 量化背景,必问细节
> "EUR 1,000 × 5% × 90/365 per unit. I round once on the whole position: EUR 73.97 for 6 units, not 6 × 12.32 = 73.92. My first version had that rounding error. The day count is simplified; a real bond follows its terms, for example ACT/ACT ICMA, plus business-day conventions."

**Q19. Record date: why?**
> "So that a transfer just before payment doesn't create double claims or none. The claim is fixed at the record date. My implementation loops over all holders, which only works for a demo; production would use snapshots or the registrar's records."

### E. 工程与产品

**Q20. How do you know it works?**
> "41 automated tests, organised by acceptance criteria. Success paths, failure paths, and attack attempts: forged keys, swapped keys, self-payment, id squatting. Tests are the specification: each state transition has one."

**Q21. What would you need for production?**
> 审计;受监管的现金腿(触发方案 / Pontes);eWpG 许可的登记机构;KYC/AML;门限解密或多个预言机;密钥管理和托管(试点里分开了交互钱包和托管钱包);隐私;监控;法律文件(试点用 ICMA BDT 作为单一数据源)。

**Q22. If you joined, what would you work on first?**
> "I'd want to understand how requirements for the next pilot iteration are captured: for example the registrar integration, which the report says should become fully on-chain. Translating that into tickets and acceptance tests is where I think I'd add value quickly."

### F. Treasury

**Q23. Why does this matter for Group Treasury?**
> 发行:数字债券的发行、付息、赎回就发生在 Treasury 流程里;流动性:T+0 和锁定现金改变了日间流动性需求;抵押品:链上抵押品和自动保证金。然后反问:"Is that how you see the link between Treasury and digital assets?"

---

## 4. 本项目 vs ERC-7573 vs 试点(差异表,背熟)

| 方面 | 本项目 | ERC-7573(EIP 页面) | 试点(2026 年 3 月) |
|---|---|---|---|
| 金额类型 | `uint` | `int` | — |
| 交易描述 | 无 | `transaction` 字段 | ICMA BDT XML |
| 钥匙生成 | 模块 3:对方生成;模块 4:预言机生成 | 双方各自提供钥匙 | 预言机生成 |
| 钥匙格式 | JSON(含付款条款) | XML 文档(合约地址 + 交易编号) | — |
| 现金侧 | ERC-20 支付合约 | 解密合约 | 联邦银行触发方案上锁定现金 |
| 链 | 两个本地 ganache | 任意 EVM | Polygon PoS + T2 |
| 预言机 | 一个 Node 脚本,RSA-3072 | 可用门限解密 | NTT DATA 托管 |

---

## 5. 3 分钟演示讲稿(英文)

1. **(20 秒)定位**:"I built simplified models of three ideas from your work, to understand them by implementing them."
2. **(40 秒)Live workflow**:提一笔 DvP 交易并结算;再提一笔 9000 欧的交易,让它失败。"Failures are recorded with a reason, not reverted, because operations needs to see every attempt. That was my product decision."
3. **(60 秒)Cross-chain DvP**:一步步点到第 7 步。"Bonds locked on one ledger, payment on the other. The payment outcome decides which key the oracle decrypts. No time-lock." 讲漏洞(Q12),展示 "The two keys" 面板。
4. **(40 秒)Coupon discharge**:停在第 6 步之后。"Payment chain says PAID, the bond still says OUTSTANDING. Only the success preimage discharges the claim." 再演示失败和重试。
5. **(20 秒)收尾**:"It's not production-ready, and I know where the gaps are. But it taught me to think in states, outcomes and failure paths, which I think is what this role needs."

**备用**:如果现场网络或电脑出问题,就用终端跑 `npm run crosschain` 和 `npm run coupon`,或者手机上提前截好的图。

---

## 6. 他可能让你"指着代码讲"的地方(一定要能讲)

| 文件 | 能讲出的要点 |
|---|---|
| `contracts/DvPSettlement.sol` `settle()` | 先检查、失败就记录;通过后两行 `transferFrom`;为什么这样能保证原子性 |
| `contracts/AssetLockingContract.sol` `transferWithKey()` | 哈希对上谁,券就给谁;为什么谁来调用都无所谓 |
| `contracts/PaymentDecryptionContract.sol` | `paymentKey(id, payee)`;`cancelAndDecrypt` 里谁能在什么状态取消;为什么每笔只请求一把钥匙 |
| `scripts/lib/erc7573.js` `decrypt()` | 预言机的 5 项检查:合约、编号、请求方、条款、方向 |
| `contracts/CouponDischarge.sol` `submitOutcome()` | 成功解除;失败只关闭尝试;重复转发直接返回 |

**练习方法**:每天随机挑一个函数,不看注释,用英语讲 1 分钟。

---

## 7. 反问清单(更新版)

1. "The pilot report lists you under Group Treasury. How do Treasury and Capital Markets split the work on the Smart Bond Contract?"(也解开了手册里"他属于哪个部门"的疑问)
2. "The report says registrar integration should become fully on-chain in the next iteration. What's the hardest part of that?"
3. "With Pontes live since September, does the Trigger Solution path in the pilot change?"
4. "In your connector paper, who should operate the connector: the participants or the payment infrastructure?"
5. "How does the reference implementation bind a key to the payment terms?"(只有在你讲过 Q12 之后才问)
6. "What would a Werkstudent typically own in the first month?"

---

## 8. 最后提醒

- 他是作者,**你讲错他的协议,比不懂更糟**。不确定就说:"I'm not sure; my understanding is…, is that right?"
- **问他问题**:作者通常喜欢被认真读过的人提问。
- 带上运行好的 demo,但**准备好不用 demo 也能讲**。
