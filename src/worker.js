export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // 只保護 /admin 開頭的路徑（後台管理頁面），其他公開頁面完全不受影響
        if (url.pathname.startsWith('/admin')) {
            const authHeader = request.headers.get('Authorization');

            if (!isAuthorized(authHeader, env.ADMIN_USER, env.ADMIN_PASSWORD)) {
                return new Response('請輸入帳號密碼才能存取後台', {
                    status: 401,
                    headers: {
                        'WWW-Authenticate': 'Basic realm="Polipoli Admin", charset="UTF-8"'
                    }
                });
            }
        }

        // 驗證通過，或非 admin 路徑，照常提供靜態檔案
        // 重新建構一個乾淨的請求（只保留網址跟方法），避免原始 request 帶著
        // Authorization 等額外標頭，被資產伺服器判定為無效請求
        const cleanRequest = new Request(url.toString(), {
            method: request.method,
            redirect: 'manual'
        });
        return env.ASSETS.fetch(cleanRequest);
    }
};

function isAuthorized(authHeader, validUser, validPass) {
    if (!authHeader || !authHeader.startsWith('Basic ')) return false;
    if (!validUser || !validPass) return false;

    try {
        const encoded = authHeader.slice(6);
        const decoded = atob(encoded);
        const separatorIndex = decoded.indexOf(':');
        if (separatorIndex === -1) return false;

        const user = decoded.slice(0, separatorIndex);
        const pass = decoded.slice(separatorIndex + 1);

        return user === validUser && pass === validPass;
    } catch (e) {
        return false;
    }
}
