using System.Globalization;
using Avalonia.Data.Converters;

namespace Yamlet.App.Controls;

/// <summary>
/// Returns true when the bound value equals the converter parameter (compared by
/// name). Used to drive rail selection highlighting and section visibility from a
/// single enum property.
/// </summary>
public sealed class EnumEqualsConverter : IValueConverter
{
    public static readonly EnumEqualsConverter Instance = new();

    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is not null &&
           parameter is not null &&
           string.Equals(value.ToString(), parameter.ToString(), StringComparison.Ordinal);

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
