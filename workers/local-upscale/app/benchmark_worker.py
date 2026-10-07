"""Future isolated worker entry point. Never invoked by preparation tests."""
import argparse
import os


def main():
    from app.video_benchmark import Policy
    from app.benchmark_resources import cap_current_process
    policy = Policy.from_env()
    if not policy.enabled and os.getenv("LOCAL_VIDEO_PRODUCTION") != "1": raise RuntimeError("Worker requires explicit benchmark or production policy")
    cap_current_process(policy.threads)  # before NumPy/ORT/torch or FFmpeg starts
    parser = argparse.ArgumentParser()
    parser.add_argument("--port",type=int,default=8092)
    args = parser.parse_args()
    import uvicorn
    from fastapi import Header
    from app.main import app
    from app.errors import WorkerError
    server = uvicorn.Server(uvicorn.Config(app,host="127.0.0.1",port=args.port,workers=1,log_level="warning"))

    @app.post("/v1/benchmark/shutdown")
    async def shutdown(authorization: str | None = Header(default=None)):
        if authorization != f"Bearer {os.environ['LOCAL_UPSCALE_WORKER_TOKEN']}":
            raise WorkerError("unauthorized","Benchmark bearer token required")
        for job in app.state.video_upscale_service.jobs.values():
            if job.status not in {"succeeded","failed","cancelled"}:
                app.state.video_upscale_service.cancel(job.id)
        server.should_exit = True
        return {"shutdown_requested":True}
    server.run()


if __name__ == "__main__": main()
