using System.Configuration;
using System.Data;
using System.Windows;

namespace FloatingWindow
{
    /// <summary>
    /// Interaction logic for App.xaml
    /// </summary>
    public partial class App : Application
    {
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            // 只构造并预热窗口；收到 floatingShow 前不得进入可见状态。
            MainWindow = new MainWindow();
        }
    }

}
