// pdf-parse.d.ts —— pdf-parse 的本地类型声明（教程《RAG TS 全链路》的两个坑）
// 坑 1：包不带 TS 类型；坑 2：ESM 下从包入口引入会误触发自检代码（去读测试文件），
// 所以统一从 lib 子路径引入（import pdf from "pdf-parse/lib/pdf-parse.js"），这里给子路径补声明。
declare module "pdf-parse/lib/pdf-parse.js" {
  /** 从 PDF 文件 Buffer 抽取纯文本：text 是全文，numpages 是页数 */
  function pdfParse(data: Buffer): Promise<{ text: string; numpages: number }>;

  export default pdfParse;
}
