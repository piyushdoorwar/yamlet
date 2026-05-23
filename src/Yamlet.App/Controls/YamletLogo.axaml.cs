using Avalonia.Controls;
using Avalonia.Markup.Xaml;

namespace Yamlet.App.Controls;

/// <summary>The Yamlet brand mark, rendered as scalable vector paths.</summary>
public partial class YamletLogo : UserControl
{
    public YamletLogo() => AvaloniaXamlLoader.Load(this);
}
