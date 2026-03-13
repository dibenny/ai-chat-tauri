import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { XProvider } from "@ant-design/x";
import App from "./App";

// 品牌色：玫瑰 / 珊瑚，与 App.css 变量一致
const theme = {
  token: {
    colorPrimary: "#D85B72",
    colorPrimaryHover: "#F4796A",
    borderRadius: 8,
  },
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <XProvider>
        <App />
      </XProvider>
    </ConfigProvider>
  </React.StrictMode>,
);
