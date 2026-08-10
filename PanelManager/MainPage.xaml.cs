using Microsoft.AspNetCore.Components.WebView;
using PanelManager.Services;
using System.Text.Json;

namespace PanelManager
{
    public partial class MainPage : ContentPage
    {
        public MainPage()
        {
            InitializeComponent();
        }

        private async void OnBlazorWebViewInitialized(
            object? sender,
            BlazorWebViewInitializedEventArgs e)
        {
#if WINDOWS
            if (e.WebView is Microsoft.UI.Xaml.Controls.WebView2 webView
                && webView.CoreWebView2 is not null)
            {
                var token = JsonSerializer.Serialize(PanelManagerHostCapability.Token);
                var script = "if(location.origin==='https://0.0.0.1'&&!Object.prototype.hasOwnProperty.call(window,'__panelManagerHostCapability')){"+
                    $"Object.defineProperty(window,'__panelManagerHostCapability',{{value:{token},writable:false,configurable:false,enumerable:false}});"+
                    "window.dispatchEvent(new Event('panelmanager-host-capability-ready'));}";
                await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);
                await webView.CoreWebView2.ExecuteScriptAsync(script);
            }
#else
            await Task.CompletedTask;
#endif
        }
    }
}
