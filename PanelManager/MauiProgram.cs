using Microsoft.Extensions.DependencyInjection;
using Microsoft.Maui.LifecycleEvents;
using PanelManager.Services;

namespace PanelManager
{
    public static class MauiProgram
    {
        public static MauiApp CreateMauiApp()
        {
            var builder = MauiApp.CreateBuilder();
            builder
                .UseMauiApp<App>()
                .ConfigureFonts(fonts =>
                {
                    fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
                });

            builder.Services.AddMauiBlazorWebView();

#if DEBUG
            builder.Services.AddBlazorWebViewDeveloperTools();
#endif

#if WINDOWS
            builder.ConfigureLifecycleEvents(events =>
            {
                events.AddWindows(windowsLifecycleBuilder =>
                {
                    windowsLifecycleBuilder.OnWindowCreated(window =>
                    {
                        if (window is not Microsoft.UI.Xaml.Window mauiWindow)
                        {
                            return;
                        }

                        var handle = WinRT.Interop.WindowNative.GetWindowHandle(mauiWindow);
                        var id = Microsoft.UI.Win32Interop.GetWindowIdFromWindow(handle);
                        var appWindow = Microsoft.UI.Windowing.AppWindow.GetFromWindowId(id);

                        var services = Microsoft.Maui.Controls.Application.Current?.Handler?.MauiContext?.Services;
                        var floatingManager = services?.GetService<Services.FloatingWindowManager>();
                        floatingManager?.AttachMainWindow(mauiWindow, appWindow);

                        if (appWindow.Presenter is Microsoft.UI.Windowing.OverlappedPresenter presenter)
                        {
                            presenter.SetBorderAndTitleBar(hasBorder: true, hasTitleBar: true);
                            presenter.IsResizable = false;
                        }
                    });
                });
            });
#endif

            // 注册 MessageBridge 服务
            builder.Services.AddSingleton<MessageBridge>();
            builder.Services.AddSingleton<FloatingWindowManager>();
            builder.Services.AddSingleton<OpenCodeSidecarService>();

            var app = builder.Build();

            // 尽早启动 WS 并注册命令，避免悬浮窗在 MainPage Loaded 前触发导致连接失败
            var bridge = app.Services.GetRequiredService<MessageBridge>();
            var floating = app.Services.GetRequiredService<FloatingWindowManager>();
            var opencode = app.Services.GetRequiredService<OpenCodeSidecarService>();
            bridge.StartWebSocket(5000);
            HostCommandHandler.Register(bridge, floating, opencode);

            return app;
        }
    }
}
