using System.Runtime.InteropServices;

namespace PanelManager
{
    public partial class App : Application
    {
        public App()
        {
            InitializeComponent();
        }

        protected override Window CreateWindow(IActivationState? activationState)
        {
            return new Window(new MainPage()) { Title = "PanelManager" , Width = 1920, Height = 1120, X = 0, Y =0 };
        }

    }
}
