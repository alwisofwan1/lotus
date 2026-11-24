use super::*;

#[tokio::test]
async fn cancellation_closes_http_while_waiting_for_headers_or_body() {
    use crate::nl_runtime::{run_cancellable, NlRuntime};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for partial_body in [false, true] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started, ready) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let mut received = Vec::new();
            while !received.ends_with(b"{}") {
                let count = socket.read(&mut buffer).await.unwrap();
                assert!(count > 0);
                received.extend_from_slice(&buffer[..count]);
            }
            if partial_body {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n{")
                    .await
                    .unwrap();
            }
            started.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(2), socket.read(&mut buffer))
                .await
                .unwrap()
        });
        let runtime = NlRuntime::new().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let request = runtime.register(&id).unwrap();
        let client = runtime.client().clone();
        let resolved = ResolvedNlModel {
            kind: NlProviderKind::OpenAi,
            api_key: "test".into(),
            model: "test".into(),
            base_url: format!("http://{address}"),
        };
        let task = tokio::spawn(run_cancellable(request, async move {
            send_once(&client, &resolved, b"{}")
                .await
                .map_err(|e| send_err_to_app(&e))
        }));
        ready.await.unwrap();
        runtime.cancel(&id);
        assert!(task.await.unwrap().is_err());
        match peer.await.unwrap() {
            Ok(0) => {}
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {}
            result => panic!("cancelled HTTP socket must close: {result:?}"),
        }
    }
}
